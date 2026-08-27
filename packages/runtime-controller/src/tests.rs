#![cfg(test)]

// NOTE: these integration-style tests expect a local Supabase stack to be running.
// Start it with `pnpm stack:up`, then point the test suite at the local Postgres
// by exporting `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`
// (the URL shown by `npx supabase status --output env` inside the `supabase/` dir).
// With that env var set you can run `cargo test --manifest-path packages/runtime-controller/Cargo.toml`.

use super::*;
use crate::auth::RequestContext;
use crate::config::{AppConfig, PgPool, RuntimeProviderConfig, StripeConfig};
use crate::connection_limit::ConnectionLimiter;
use crate::dispatch::{self, DispatchPromptRequest};
use crate::jwks::SupabaseJwks;
use crate::model_defaults::{default_managed_ai_model_id, default_managed_ai_model_label};
use crate::origins::{
    acquire_fresh_lease, acquire_lease, authorize_workspace_origin_git_write, post_access_token,
    post_commit_receipt, post_origin_register, record_access_grant, record_commit_receipt,
    record_presence_heartbeat, release_lease, renew_lease, renew_long_lease,
    resolve_origin_for_protocol, upsert_workspace_origin, AccessTokenRequest, CommitReceiptBody,
    LeaseAcquireOutcome, OriginMode, OriginPresenceStatus, OriginRegisterBody,
};
use crate::rate_limit::RateLimiter;
use crate::tokens::{decode_scoped_token, mint_scoped_token, ScopedTokenRequest};
use crate::tunnels::{
    revoke_tunnels_for_scope, DynTunnelBroker, TunnelAssignment, TunnelBroker, TunnelProvider,
    TunnelRequestContext,
};
use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{HeaderValue, Request, StatusCode},
    Json as AxumJson,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use bb8_postgres::PostgresConnectionManager;
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::StreamExt;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use runtime_contracts::{AccessTokenClaims, GIT_DELETE_SCOPE, GIT_DELETE_TOKEN_TTL_SECONDS};
use serde_json::json;
use std::collections::HashMap;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, OnceLock,
};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_postgres::{types::Json as PgJson, NoTls};
use tower::ServiceExt;
use uuid::Uuid;

struct TestOriginKeyPair {
    private_pem: String,
    public_pem: String,
}

static TEST_ORIGIN_KEY_PAIR: OnceLock<TestOriginKeyPair> = OnceLock::new();

const ED25519_PUBLIC_KEY_SPKI_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

pub(crate) fn test_origin_private_key() -> &'static str {
    &test_origin_key_pair().private_pem
}

pub(crate) fn test_origin_public_key() -> &'static str {
    &test_origin_key_pair().public_pem
}

fn test_origin_key_pair() -> &'static TestOriginKeyPair {
    TEST_ORIGIN_KEY_PAIR.get_or_init(|| {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate test origin keypair");
        let key_pair =
            Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse test origin keypair");

        let mut public_der = ED25519_PUBLIC_KEY_SPKI_PREFIX.to_vec();
        public_der.extend_from_slice(key_pair.public_key().as_ref());

        TestOriginKeyPair {
            private_pem: format_pem_block("PRIVATE KEY", pkcs8.as_ref()),
            public_pem: format_pem_block("PUBLIC KEY", &public_der),
        }
    })
}

fn format_pem_block(label: &str, der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let mut pem = format!("-----BEGIN {label}-----\n");
    for chunk in body.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 chunk utf8"));
        pem.push('\n');
    }
    pem.push_str(&format!("-----END {label}-----"));
    pem
}

#[derive(Clone, Default)]
struct StubTunnelBroker {
    fail_revoke: bool,
}

#[async_trait]
impl TunnelBroker for StubTunnelBroker {
    fn provider_kind(&self) -> TunnelProvider {
        TunnelProvider::SelfHosted
    }

    async fn request_tunnel(&self, ctx: TunnelRequestContext) -> anyhow::Result<TunnelAssignment> {
        let runtime_id = ctx.runtime_id.unwrap_or_else(Uuid::new_v4).to_string();
        let hostname = format!("instafy-test-{}.example.dev", runtime_id[..8].to_string());
        let url = format!("https://{}", hostname);
        let expires_at = Utc::now() + ChronoDuration::minutes(10);
        let tunnel_id = Uuid::new_v4().to_string();
        Ok(TunnelAssignment {
            provider: TunnelProvider::SelfHosted,
            tunnel_id,
            hostname: hostname.clone(),
            url,
            status: "active".to_string(),
            credentials: json!({
                "provider": TunnelProvider::SelfHosted.as_str(),
                "hostname": hostname,
                "token": "test-secret-tunnel-token",
            }),
            expires_at,
            metadata: Some(json!({
                "provider": "self_hosted",
                "dnsRecordId": "dns-record-id",
                "dnsRecordName": hostname,
            })),
        })
    }

    async fn revoke_tunnel(
        &self,
        _tunnel_id: &str,
        _metadata: Option<&serde_json::Value>,
    ) -> anyhow::Result<()> {
        if self.fail_revoke {
            anyhow::bail!("injected broker revoke failure");
        }
        Ok(())
    }
}

pub(crate) fn build_app_config(private_key: &str, public_key: &str, key_id: &str) -> AppConfig {
    AppConfig {
        origin_token_private_key: Some(private_key.to_string()),
        origin_token_public_key: Some(public_key.to_string()),
        origin_token_key_id: Some(key_id.to_string()),
        origin_token_ttl_seconds: 300,
        port: 0,
        database_url: "".to_string(),
        database_pool_size: 2,
        redis_url: None,
        redis_namespace: None,
        redis_events_channel: None,
        _supabase_project_url: "".to_string(),
        supabase_jwks_url: "".to_string(),
        supabase_jwks: Arc::new(tokio::sync::RwLock::new(SupabaseJwks::from_hmac_secret(
            "secret",
        ))),
        supabase_jwks_refresh_seconds: 300,
        supabase_jwks_refresh_enabled: false,
        controller_internal_token: Some("internal".to_string()),
        proxy_credential_lease_token: Some("credential-lease".to_string()),
        supabase_service_role_key: Some("service-role-token".to_string()),
        agent_token_ttl_seconds: 3600,
        user_token_ttl_seconds: 900,
        user_token_secret: "secret".to_string(),
        lease_path: "/agent/lease".to_string(),
        heartbeat_path: "/agent/heartbeat".to_string(),
        stop_path: "/runtime/stop".to_string(),
        proxy_signing_secret: None,
        proxy_base_url: None,
        proxy_token_ttl_seconds: 1800,
        credential_encryption_key: None,
        browser_profile_persist_project_ids: vec![],
        browser_profile_snapshot_secs: 30,
        progress_callback_secret: None,
        git_remote_base_url: None,
        git_remote_public_base_url: None,
        git_shards: vec![],
        hosted_origin_endpoint: None,
        browser_turn_rest: None,
        sandbox_credit_seed_amount: 25,
        sandbox_credit_seed_limit: 25,
        billing_unit_label: "credits".to_string(),
        billing_units_per_usd: 1_000,
        tunnel_credit_burn_amount: 0,
        tunnel_credit_burn_interval_seconds: 600,
        tunnel_credit_burn_lead_seconds: 60,
        hosted_runtime_credit_burn_amount: 0,
        hosted_runtime_credit_burn_interval_seconds: 600,
        managed_ai_enabled: true,
        managed_ai_label: "Instafy AI".to_string(),
        managed_ai_credit_burn_amount: 1,
        managed_ai_daily_prompt_limit: 20,
        managed_ai_model_id: default_managed_ai_model_id().to_string(),
        managed_ai_model_label: default_managed_ai_model_label().to_string(),
        managed_ai_input_usd_micros_per_1k: 250,
        managed_ai_cached_input_usd_micros_per_1k: 25,
        managed_ai_output_usd_micros_per_1k: 2_000,
        managed_ai_startup_check: true,
        tunnel_broker_hook_secret: None,
        git_event_hook_secret: None,
        _controller_external_url: None,
        public_app_url: "https://instafy.dev".to_string(),
        workspace_root: None,
        strict_mode: false,
        dev_isolation_mode: false,
        dev_mode: false,
        runtime_idle_release_seconds: 150,
        runtime_idle_stop_seconds: 1800,
        max_orgs_per_user: 5,
        max_active_hosted_runtimes_global: 0,
        auto_create_projects: false,
        service_runtime_user_id: None,
        dev_project_registry_path: None,
        runtime_providers: vec![RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        }],
        self_hosted_tunnel_broker: None,
        stripe: None,
        operator_console_org_id: None,
        operator_console_allowed_user_ids: vec![],
        bug_reports_operator_user_ids: vec![],
        desktop_release_github_owner: None,
        desktop_release_github_repo: None,
        desktop_release_github_token: None,
        desktop_release_promote_workflow: "desktop-promote.yml".to_string(),
        cloudflare_api_token: None,
        cloudflare_zone_id: None,
        downloads_public_host: "downloads.instafy.dev".to_string(),
        desktop_downloads_prefix: "desktop-app".to_string(),
        mobile_ota_downloads_prefix: "mobile".to_string(),
        web_push_vapid_public_key: None,
        web_push_vapid_private_key: None,
        web_push_vapid_subject: None,
        apns_key_id: None,
        apns_team_id: None,
        apns_bundle_id: None,
        apns_private_key: None,
        apns_use_sandbox: false,
    }
}

pub(crate) fn build_test_state(pool: PgPool, config: AppConfig) -> AppState {
    let mut provider_configs = HashMap::new();
    for provider in config.runtime_providers.iter().cloned() {
        provider_configs.insert(
            crate::provider_identifiers::provider_id_key(&provider.id),
            provider,
        );
    }
    if provider_configs.is_empty() {
        provider_configs.insert(
            "default".to_string(),
            RuntimeProviderConfig {
                id: "default".to_string(),
                display_name: "Default".to_string(),
                kind: "noop".to_string(),
                owner_org_id: None,
                allowed_org_ids: vec![],
                endpoint: None,
                auth_token: None,
                metadata: None,
            },
        );
    }
    let default_provider_id = provider_configs
        .keys()
        .next()
        .cloned()
        .unwrap_or_else(|| "default".to_string());
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, default_provider_id);
    let ota_registry = crate::ota::OtaRegistry::new_in_memory();

    AppState {
        config,
        pool,
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    }
}

fn test_ota_registry(config: &AppConfig) -> crate::ota::OtaRegistry {
    let _ = config;
    crate::ota::OtaRegistry::new_in_memory()
}

#[test]
fn decode_scoped_token_round_trip() {
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    let project_id = Uuid::new_v4();
    let runtime_id_str = Uuid::new_v4().to_string();
    let scopes = vec![
        "agent.lease".to_string(),
        "agent.heartbeat".to_string(),
        "agent.complete".to_string(),
    ];

    let minted = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: runtime_id_str.clone(),
            subject: "agent:test".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id_str.clone()),
            protocol: None,
            scopes: scopes.clone(),
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(120),
        },
    )
    .expect("mint agent token");

    let mut direct_validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::EdDSA);
    direct_validation.validate_aud = false;
    let direct = jsonwebtoken::decode::<AccessTokenClaims>(
        &minted.token,
        &jsonwebtoken::DecodingKey::from_ed_pem(test_origin_public_key().as_bytes())
            .expect("decoding key"),
        &direct_validation,
    );
    assert!(direct.is_ok(), "direct decode failed: {:?}", direct.err());

    let claims =
        decode_scoped_token(&config, &minted.token, "agent token").expect("decode agent token");

    assert_eq!(claims.project_id, project_id.to_string());
    assert_eq!(claims.runtime_id.as_deref(), Some(runtime_id_str.as_str()));
    assert_eq!(claims.aud, runtime_id_str);
    assert_eq!(claims.scopes, scopes);
    assert_eq!(claims.sub, "agent:test");
}

#[tokio::test]
async fn concurrent_browser_profile_table_initialization_is_deadlock_free() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping browser profile schema concurrency test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let initialize_all = async {
        let mut initializers = tokio::task::JoinSet::new();
        for _ in 0..10 {
            let pool = pool.clone();
            initializers.spawn(async move {
                crate::browser_profile::ensure_browser_profiles_table(&pool).await
            });
        }
        while let Some(result) = initializers.join_next().await {
            result.map_err(|error| {
                anyhow::anyhow!("browser profile initializer panicked: {error}")
            })??;
        }
        Ok::<_, anyhow::Error>(())
    };

    timeout(std::time::Duration::from_secs(10), initialize_all)
        .await
        .map_err(|_| {
            anyhow::anyhow!("parallel browser profile table initialization timed out")
        })??;
    Ok(())
}

#[tokio::test]
async fn delete_project_purges_durable_browser_profile() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping browser profile deletion test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;

    let project_id = Uuid::new_v4();
    let profile_id = Uuid::new_v4();
    let connection = pool.get().await?;
    connection
        .execute("insert into projects (id) values ($1)", &[&project_id])
        .await?;
    connection
        .execute(
            "insert into project_browser_profiles
               (id, project_id, scope, version, nonce_b64, ciphertext_b64, bytes)
             values ($1, $2, 'project', 1, 'nonce', 'ciphertext', 10)",
            &[&profile_id, &project_id],
        )
        .await?;
    drop(connection);

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "browser-profile-delete-test",
    );
    config.browser_profile_persist_project_ids.push(project_id);
    let stale_agent_token = crate::auth::issue_agent_token_with_browser_profile_scope_for_test(
        &config,
        &project_id,
        &Uuid::new_v4(),
        None,
        None,
    )
    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?
    .token;
    let state = build_test_state(pool.clone(), config);
    let response = crate::projects::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/projects/{project_id}"))
                .header("authorization", "Bearer service-role-token")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let repeated_delete = crate::projects::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/projects/{project_id}"))
                .header("authorization", "Bearer service-role-token")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(
        repeated_delete.status(),
        StatusCode::NO_CONTENT,
        "service-role recovery must be able to repeat a committed project tombstone"
    );

    let connection = pool.get().await?;
    let status: String = connection
        .query_one("select status from projects where id = $1", &[&project_id])
        .await?
        .get(0);
    let profile_count: i64 = connection
        .query_one(
            "select count(*) from project_browser_profiles where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(status, "deleted");
    assert_eq!(profile_count, 0);
    drop(connection);

    let stale_put = crate::browser_profile::router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/agent/browser-profile")
                .header("authorization", format!("Bearer {stale_agent_token}"))
                .body(Body::from("must-not-be-stored"))?,
        )
        .await?;
    assert_eq!(stale_put.status(), StatusCode::NOT_FOUND);

    let connection = pool.get().await?;
    let profile_count: i64 = connection
        .query_one(
            "select count(*) from project_browser_profiles where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(profile_count, 0);
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn project_builder_can_reset_browser_profile_after_policy_revocation() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping browser profile reset authorization test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;

    let project_id = Uuid::new_v4();
    let builder_user_id = Uuid::new_v4();
    let viewer_user_id = Uuid::new_v4();
    let private_runtime_id = Uuid::new_v4();
    ensure_test_user(&pool, &builder_user_id).await?;
    ensure_test_user(&pool, &viewer_user_id).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        for (user_id, role) in [(builder_user_id, "builder"), (viewer_user_id, "viewer")] {
            connection
                .execute(
                    "insert into project_memberships (project_id, user_id, role)
                     values ($1, $2, $3)",
                    &[&project_id, &user_id, &role],
                )
                .await?;
        }
        connection
            .execute(
                "insert into project_browser_profiles
                   (id, project_id, scope, version, nonce_b64, ciphertext_b64, bytes)
                 values ($1, $2, 'project', 1, 'nonce', 'ciphertext', 10)",
                &[&Uuid::new_v4(), &project_id],
            )
            .await?;
        let private_capabilities = json!({
            "_instafySelfHostedAccess": {
                "mode": "private",
                "ownerUserId": viewer_user_id.to_string(),
            }
        });
        connection
            .execute(
                "insert into runtimes
                   (id, project_id, provider, status, capabilities,
                    idle_ttl_seconds, last_seen_at)
                 values ($1, $2, 'instafy-cloud', 'ready', $3, 600, now())",
                &[&private_runtime_id, &project_id, &private_capabilities],
            )
            .await?;
    }

    // Intentionally leave the persistence allowlist empty. Removing rollout
    // access must not make already-stored shared login state impossible to
    // clear.
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "browser-profile-reset-authorization",
    );
    let builder_token = crate::auth::issue_controller_token(&config, &builder_user_id)
        .expect("mint builder token")
        .token;
    let viewer_token = crate::auth::issue_controller_token(&config, &viewer_user_id)
        .expect("mint viewer token")
        .token;
    let app = crate::browser_profile::router().with_state(build_test_state(pool.clone(), config));

    let viewer_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/projects/{project_id}/browser-profile"))
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(viewer_response.status(), StatusCode::FORBIDDEN);
    let profile_count: i64 = pool
        .get()
        .await?
        .query_one(
            "select count(*) from project_browser_profiles where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(profile_count, 1, "viewer denial must retain the profile");

    let builder_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/projects/{project_id}/browser-profile"))
                .header("authorization", format!("Bearer {builder_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(builder_response.status(), StatusCode::OK);
    let builder_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(builder_response.into_body(), usize::MAX).await?)?;
    assert_eq!(builder_body["ok"], true);
    assert_eq!(builder_body["cleared"], true);
    assert_eq!(builder_body["stoppedRuntimeIds"], json!([]));
    let private_runtime_status: String = pool
        .get()
        .await?
        .query_one(
            "select status from runtimes where id = $1",
            &[&private_runtime_id],
        )
        .await?
        .get("status");
    assert_eq!(
        private_runtime_status, "ready",
        "profile reset must not stop a protected private runtime even when its provider id is canonical"
    );

    let repeated_response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/projects/{project_id}/browser-profile"))
                .header("authorization", format!("Bearer {builder_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(repeated_response.status(), StatusCode::OK);
    let repeated_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(repeated_response.into_body(), usize::MAX).await?)?;
    assert_eq!(repeated_body["cleared"], false);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &builder_user_id).await?;
    cleanup_test_user(&pool, &viewer_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn browser_profile_reset_retains_profile_when_provider_release_cannot_be_proven(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping browser profile reset release test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_browser_profiles
                   (id, project_id, scope, version, nonce_b64, ciphertext_b64, bytes)
                 values ($1, $2, 'project', 1, 'nonce', 'ciphertext', 10)",
                &[&Uuid::new_v4(), &project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, updated_at
                 ) values (
                     $1, $2, 'instafy-cloud', 'offline', 'http://runtime.invalid',
                     'browser-profile-reset-runtime', 600, now(), now()
                 )",
                &[&runtime_id, &project_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "browser-profile-reset-provider-release",
    );
    let app = crate::browser_profile::router().with_state(build_test_state(pool.clone(), config));
    let reset_request = || {
        Request::builder()
            .method("DELETE")
            .uri(format!("/projects/{project_id}/browser-profile"))
            .header("authorization", "Bearer service-role-token")
            .body(Body::empty())
    };

    let failed_reset = app.clone().oneshot(reset_request()?).await?;
    let failed_status = failed_reset.status();
    let failed_body = to_bytes(failed_reset.into_body(), usize::MAX).await?;
    assert_eq!(
        failed_status,
        StatusCode::CONFLICT,
        "unexpected reset response: {}",
        String::from_utf8_lossy(&failed_body)
    );
    let failed_json: serde_json::Value = serde_json::from_slice(&failed_body)?;
    assert_eq!(
        failed_json["message"],
        "provider-managed runtime is missing its active lease generation"
    );
    {
        let connection = pool.get().await?;
        let profile_count: i64 = connection
            .query_one(
                "select count(*) from project_browser_profiles where project_id = $1",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(
            profile_count, 1,
            "ambiguous provider cleanup must retain the encrypted profile"
        );
        let runtime = connection
            .query_one(
                "select status, active_lease_id from runtimes where id = $1",
                &[&runtime_id],
            )
            .await?;
        assert_eq!(runtime.get::<_, String>("status"), "offline");
        assert_eq!(runtime.get::<_, Option<Uuid>>("active_lease_id"), None);

        // `removed` is also only a local lifecycle state. Without an ordered
        // provider-release acknowledgement it must remain fail-closed just
        // like an offline heartbeat.
        connection
            .execute(
                "update runtimes set status = 'removed', updated_at = now() where id = $1",
                &[&runtime_id],
            )
            .await?;
    }

    let removed_reset = app.clone().oneshot(reset_request()?).await?;
    let removed_status = removed_reset.status();
    let removed_body = to_bytes(removed_reset.into_body(), usize::MAX).await?;
    assert_eq!(
        removed_status,
        StatusCode::CONFLICT,
        "unexpected removed-runtime reset response: {}",
        String::from_utf8_lossy(&removed_body)
    );
    let removed_json: serde_json::Value = serde_json::from_slice(&removed_body)?;
    assert_eq!(
        removed_json["message"],
        "provider-managed runtime is missing its active lease generation"
    );
    {
        let connection = pool.get().await?;
        let profile_count: i64 = connection
            .query_one(
                "select count(*) from project_browser_profiles where project_id = $1",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(
            profile_count, 1,
            "removed runtime without provider proof must retain the encrypted profile"
        );

        // Model operator/provider recovery proving the runtime terminal. The
        // idempotent retry may now clear the retained encrypted profile.
        connection
            .execute(
                "update runtimes
                 set status = 'stopped', endpoint_url = null, task_ref = null,
                     last_seen_at = null, updated_at = now()
                 where id = $1",
                &[&runtime_id],
            )
            .await?;
    }

    let successful_reset = app.oneshot(reset_request()?).await?;
    assert_eq!(successful_reset.status(), StatusCode::OK);
    let successful_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(successful_reset.into_body(), usize::MAX).await?)?;
    assert_eq!(successful_body["cleared"], true);
    assert_eq!(successful_body["stoppedRuntimeIds"], json!([]));

    {
        let connection = pool.get().await?;
        let profile_count: i64 = connection
            .query_one(
                "select count(*) from project_browser_profiles where project_id = $1",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(profile_count, 0);
        let runtime = connection
            .query_one(
                "select status, active_lease_id from runtimes where id = $1",
                &[&runtime_id],
            )
            .await?;
        assert_eq!(runtime.get::<_, String>("status"), "stopped");
        assert_eq!(runtime.get::<_, Option<Uuid>>("active_lease_id"), None);
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn service_role_organization_delete_is_idempotent_for_recovery() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping organization delete recovery test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let org_id = Uuid::new_v4();
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'Recovery Org')",
            &[&org_id, &format!("recovery-org-{org_id}")],
        )
        .await?;
    drop(connection);

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "service-role-org-delete-recovery",
        ),
    );

    for attempt in 1..=2 {
        let response = crate::projects::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/orgs/{org_id}"))
                    .header("authorization", "Bearer service-role-token")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(
            response.status(),
            StatusCode::NO_CONTENT,
            "service-role organization cleanup attempt {attempt} must be idempotent"
        );
    }

    let connection = pool.get().await?;
    let org_count: i64 = connection
        .query_one(
            "select count(*) from organizations where id = $1",
            &[&org_id],
        )
        .await?
        .get(0);
    assert_eq!(org_count, 0);

    Ok(())
}

#[tokio::test]
async fn active_self_hosted_runtimes_cannot_access_browser_profiles() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted browser-profile boundary test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;

    let project_id = Uuid::new_v4();
    let self_hosted_runtime_id = Uuid::new_v4();
    let custom_self_hosted_runtime_id = Uuid::new_v4();
    let self_hosted_generation = Uuid::new_v4();
    let custom_self_hosted_generation = Uuid::new_v4();
    let self_hosted_owner_user_id = Uuid::new_v4();
    let mut self_hosted_capabilities = json!({ "agent": true });
    crate::runtime::set_runtime_generation_capability(
        &mut self_hosted_capabilities,
        self_hosted_generation,
    );
    crate::runtime::set_self_hosted_access_attestation(
        self_hosted_capabilities
            .as_object_mut()
            .expect("test capabilities are an object"),
        self_hosted_owner_user_id,
    );
    let mut custom_self_hosted_capabilities = json!({ "agent": true });
    crate::runtime::set_runtime_generation_capability(
        &mut custom_self_hosted_capabilities,
        custom_self_hosted_generation,
    );
    crate::runtime::set_self_hosted_access_attestation(
        custom_self_hosted_capabilities
            .as_object_mut()
            .expect("test capabilities are an object"),
        self_hosted_owner_user_id,
    );

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) values
                   ($1, $3, 'self-hosted', 'ready', 'http://runtime.invalid',
                    $4, 600, now(), $5),
                   ($2, $3, 'instafy-cloud-custom', 'ready', 'http://runtime.invalid',
                    $6, 600, now(), $7)",
                &[
                    &self_hosted_runtime_id,
                    &custom_self_hosted_runtime_id,
                    &project_id,
                    &format!("browser-profile-self-hosted-{self_hosted_runtime_id}"),
                    &self_hosted_capabilities,
                    &format!("browser-profile-custom-self-hosted-{custom_self_hosted_runtime_id}"),
                    &custom_self_hosted_capabilities,
                ],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "self-hosted-browser-profile-boundary",
    );
    config.browser_profile_persist_project_ids.push(project_id);
    let runtime_tokens = [
        (
            "self-hosted",
            crate::auth::issue_agent_token_with_browser_profile_scope_for_test(
                &config,
                &project_id,
                &self_hosted_runtime_id,
                None,
                Some(self_hosted_generation),
            ),
        ),
        (
            "cloud-looking custom",
            crate::auth::issue_agent_token_with_browser_profile_scope_for_test(
                &config,
                &project_id,
                &custom_self_hosted_runtime_id,
                None,
                Some(custom_self_hosted_generation),
            ),
        ),
    ];
    let app = crate::browser_profile::router().with_state(build_test_state(pool.clone(), config));

    for (runtime_label, token_result) in runtime_tokens {
        let agent_token = token_result
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?
            .token;
        for method in ["GET", "PUT"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/agent/browser-profile")
                        .header(
                            axum::http::header::AUTHORIZATION,
                            format!("Bearer {agent_token}"),
                        )
                        .body(if method == "PUT" {
                            Body::from("must-not-be-stored")
                        } else {
                            Body::empty()
                        })?,
                )
                .await?;
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "active {runtime_label} runtime must be denied for browser-profile {method}"
            );
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
            assert_eq!(
                body["message"],
                json!(
                    "browser profile persistence is available only on managed Instafy Cloud runtimes"
                )
            );
        }
    }

    let connection = pool.get().await?;
    let profile_count: i64 = connection
        .query_one(
            "select count(*) from project_browser_profiles where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(profile_count, 0);
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn active_managed_cloud_runtime_can_put_and_get_browser_profile() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping managed-cloud browser-profile test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) values (
                     $1, $2, 'instafy-cloud', 'ready', 'http://runtime.invalid',
                     $3, 600, now(), '{\"agent\":true}'::jsonb
                 )",
                &[
                    &runtime_id,
                    &project_id,
                    &format!("browser-profile-cloud-{runtime_id}"),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) values ($1, $2, $3, 'active', now(), now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "managed-cloud-browser-profile-boundary",
    );
    config.browser_profile_persist_project_ids.push(project_id);
    config.credential_encryption_key = Some(crate::config::CredentialEncryptionKey::for_test(
        "managed-cloud-browser-profile-test-key",
    ));
    let agent_token = crate::auth::issue_agent_token_for_runtime(
        &config,
        &project_id,
        &runtime_id,
        Some(&lease_id),
        None,
        "instafy-cloud",
        &json!({ "agent": true }),
    )
    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?
    .token;
    let app = crate::browser_profile::router().with_state(build_test_state(pool.clone(), config));
    let profile = b"managed-cloud-browser-profile";

    let put_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/agent/browser-profile")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {agent_token}"),
                )
                .body(Body::from(profile.as_slice()))?,
        )
        .await?;
    let put_status = put_response.status();
    let put_body = to_bytes(put_response.into_body(), usize::MAX).await?;
    assert_eq!(
        put_status,
        StatusCode::OK,
        "managed-cloud profile PUT failed: {}",
        String::from_utf8_lossy(&put_body)
    );
    let manifest: serde_json::Value = serde_json::from_slice(&put_body)?;
    assert_eq!(manifest["scope"], json!("project"));
    assert_eq!(manifest["version"], json!(1));
    assert_eq!(manifest["bytes"], json!(profile.len()));

    let get_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/agent/browser-profile")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {agent_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(get_response.status(), StatusCode::OK);
    assert_eq!(
        get_response
            .headers()
            .get("x-instafy-profile-version")
            .and_then(|value| value.to_str().ok()),
        Some("1")
    );
    assert_eq!(
        to_bytes(get_response.into_body(), usize::MAX)
            .await?
            .as_ref(),
        profile
    );

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn private_self_hosted_origin_tokens_are_owner_bound_and_revoked_on_rotation(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private origin-token boundary test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let origin_instance_id = Uuid::new_v4();
    let generation = Uuid::new_v4();
    let mut capabilities = json!({ "agent": true, "origin": true });
    crate::runtime::set_runtime_generation_capability(&mut capabilities, generation);
    crate::runtime::set_self_hosted_access_attestation(
        capabilities
            .as_object_mut()
            .expect("test capabilities are an object"),
        owner_user_id,
    );

    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &teammate_user_id).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &teammate_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) values (
                     $1, $2, 'self-hosted', 'ready', 'http://runtime.invalid',
                     $3, 600, now(), $4
                 )",
                &[
                    &runtime_id,
                    &project_id,
                    &format!("private-origin-runtime-{runtime_id}"),
                    &capabilities,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                 values ($1, $2, 'desktop', 'http://127.0.0.1:9', ARRAY['http']::text[])",
                &[&origin_id, &project_id],
            )
            .await?;
        let protocols = vec!["http".to_string()];
        connection
            .execute(
                "insert into origin_instances (
                     id, project_id, runtime_id, origin_id, required, mode, status,
                     endpoint, protocols, metadata
                 ) values (
                     $1, $2, $3, $4, true, 'desktop', 'online',
                     'http://127.0.0.1:9', $5::text[], '{}'::jsonb
                 )",
                &[
                    &origin_instance_id,
                    &project_id,
                    &runtime_id,
                    &origin_id,
                    &protocols,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "private-origin-token-boundary",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .expect("mint owner controller token")
        .token;
    let teammate_token = crate::auth::issue_controller_token(&config, &teammate_user_id)
        .expect("mint teammate controller token")
        .token;
    let state = build_test_state(pool.clone(), config.clone());
    let app = crate::origins::router().with_state(state);
    let access_body = json!({
        "projectId": project_id.to_string(),
        "protocol": "http",
        "scopes": ["fs.read"],
        "originId": origin_id.to_string()
    });

    let teammate_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/access_token")
                .header("authorization", format!("Bearer {teammate_token}"))
                .header("content-type", "application/json")
                .body(Body::from(access_body.to_string()))?,
        )
        .await?;
    assert_eq!(teammate_response.status(), StatusCode::FORBIDDEN);

    let owner_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/access_token")
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(access_body.to_string()))?,
        )
        .await?;
    let owner_status = owner_response.status();
    let owner_body = to_bytes(owner_response.into_body(), usize::MAX).await?;
    assert_eq!(
        owner_status,
        StatusCode::OK,
        "owner token response: {}",
        String::from_utf8_lossy(&owner_body)
    );
    let owner_payload: serde_json::Value = serde_json::from_slice(&owner_body)?;
    let origin_token = owner_payload["token"]
        .as_str()
        .expect("origin token present");
    let origin_claims = decode_scoped_token(&config, origin_token, "origin access token")
        .expect("decode private origin token");
    assert_eq!(
        origin_claims.runtime_id.as_deref(),
        Some(runtime_id.to_string().as_str())
    );
    assert_eq!(
        origin_claims.runtime_generation.as_deref(),
        Some(generation.to_string().as_str())
    );

    let successor_generation = Uuid::new_v4();
    crate::runtime::set_runtime_generation_capability(&mut capabilities, successor_generation);
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update runtimes set capabilities = $2, updated_at = now() where id = $1",
                &[&runtime_id, &capabilities],
            )
            .await?;
    }

    let stale_proxy_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/origin/{origin_id}/entries"))
                .header("authorization", format!("Bearer {origin_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(stale_proxy_response.status(), StatusCode::UNAUTHORIZED);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &teammate_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn stopped_self_hosted_runtime_loses_browser_profile_capability() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping stopped browser-profile runtime test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let runtime_generation = Uuid::new_v4();
    let runtime_owner_user_id = Uuid::new_v4();
    let mut capabilities = json!({ "agent": true });
    crate::runtime::set_runtime_generation_capability(&mut capabilities, runtime_generation);
    crate::runtime::set_self_hosted_access_attestation(
        capabilities
            .as_object_mut()
            .expect("test capabilities are an object"),
        runtime_owner_user_id,
    );

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) values (
                     $1, $2, 'self-hosted', 'stopped', 'http://runtime.invalid',
                     $3, 600, now(), $4
                 )",
                &[
                    &runtime_id,
                    &project_id,
                    &format!("stopped-browser-profile-{runtime_id}"),
                    &capabilities,
                ],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "stopped-browser-profile-runtime",
    );
    config.browser_profile_persist_project_ids.push(project_id);
    let agent_token = crate::auth::issue_agent_token_with_browser_profile_scope_for_test(
        &config,
        &project_id,
        &runtime_id,
        None,
        Some(runtime_generation),
    )
    .map_err(|(status, body)| {
        anyhow::anyhow!(
            "issue browser-profile agent token: {status}: {}",
            body.0.message
        )
    })?
    .token;
    let app = crate::browser_profile::router().with_state(build_test_state(pool.clone(), config));

    for method in ["GET", "PUT"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/agent/browser-profile")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {agent_token}"),
                    )
                    .body(if method == "PUT" {
                        Body::from("must-not-be-stored")
                    } else {
                        Body::empty()
                    })?,
            )
            .await?;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "stopped runtime must be denied for browser-profile {method}"
        );
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        assert_eq!(
            body["message"],
            json!("agent token runtime is no longer active")
        );
    }

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update runtimes set status = 'ready', updated_at = now() where id = $1",
                &[&runtime_id],
            )
            .await?;
    }
    let ready_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/agent/browser-profile")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {agent_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(
        ready_response.status(),
        StatusCode::FORBIDDEN,
        "current self-hosted runtime must remain outside the browser-profile boundary"
    );

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

async fn connect_test_db() -> anyhow::Result<Option<(tokio_postgres::Client, JoinHandle<()>)>> {
    let url = match std::env::var("TEST_DATABASE_URL") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };

    let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
    let handle = tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("[runtime-controller tests] connection error: {error}");
        }
    });

    client.batch_execute("SET search_path TO pg_temp;").await?;

    Ok(Some((client, handle)))
}

async fn create_runtime_spread_scope_tables(client: &tokio_postgres::Client) -> anyhow::Result<()> {
    client
        .batch_execute(
            "CREATE TEMP TABLE runtimes (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                provider text NOT NULL DEFAULT 'instafy-cloud',
                status text NOT NULL,
                capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
                active_lease_id uuid
            );
            CREATE TEMP TABLE runtime_leases (
                id uuid PRIMARY KEY,
                metadata jsonb,
                released_at timestamptz
            );",
        )
        .await?;
    Ok(())
}

async fn create_conversation_tables(client: &mut tokio_postgres::Client) -> anyhow::Result<()> {
    client
        .batch_execute(
            "CREATE TEMP TABLE projects (
                id uuid PRIMARY KEY,
                org_id uuid,
                name text,
                sandbox_session_id uuid,
                project_type text,
                owner_user_id uuid,
                status text
            );
            CREATE TEMP TABLE conversations (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                session_id uuid,
                created_by uuid,
                metadata jsonb,
                visibility text NOT NULL DEFAULT 'public',
                parent_conversation_id uuid,
                root_conversation_id uuid,
                thread_kind text,
                last_message_id uuid,
                last_message_at timestamptz,
                last_message_preview text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TEMP TABLE conversation_participants (
                conversation_id uuid NOT NULL,
                user_id uuid NOT NULL,
                role text NOT NULL DEFAULT 'member',
                added_by uuid,
                last_seen_message_id uuid,
                last_seen_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (conversation_id, user_id)
            );
            CREATE TEMP TABLE conversation_messages (
                id uuid PRIMARY KEY,
                conversation_id uuid NOT NULL,
                project_id uuid NOT NULL,
                session_id uuid,
                prompt_id uuid,
                run_id uuid,
                role text NOT NULL,
                content text NOT NULL,
                metadata jsonb,
                created_by uuid,
                created_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;

    Ok(())
}

pub(crate) async fn setup_origin_test_pool() -> anyhow::Result<Option<PgPool>> {
    let url = match std::env::var("TEST_DATABASE_URL") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };

    let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
    let connection_handle = tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("[runtime-controller tests] connection error: {error}");
        }
    });

    client
        .batch_execute(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id uuid PRIMARY KEY,
                org_id uuid,
                name text,
                sandbox_session_id uuid,
                project_type text,
                owner_user_id uuid,
                status text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                session_id uuid,
                created_by uuid,
                metadata jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS runtimes (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                provider text NOT NULL,
                status text NOT NULL,
                endpoint_url text,
                task_ref text,
                idle_ttl_seconds integer NOT NULL DEFAULT 3600,
                last_seen_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS workspace_origins (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                mode text NOT NULL,
                endpoint text NOT NULL,
                protocols text[] NOT NULL DEFAULT array[]::text[],
                region text,
                device_id text,
                metadata jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS workspace_leases (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id uuid,
                runtime_id uuid,
                status text NOT NULL,
                acquired_at timestamptz NOT NULL,
                expires_at timestamptz NOT NULL,
                released_at timestamptz,
                metadata jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS origin_presence (
                origin_id uuid PRIMARY KEY REFERENCES workspace_origins(id) ON DELETE CASCADE,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                status text NOT NULL,
                last_heartbeat timestamptz NOT NULL DEFAULT now(),
                latency_ms integer,
                region text,
                metadata jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS workspace_commit_receipts (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                origin_id uuid NOT NULL REFERENCES workspace_origins(id) ON DELETE CASCADE,
                lease_id uuid REFERENCES workspace_leases(id) ON DELETE SET NULL,
                user_id uuid,
                rev text NOT NULL,
                bytes_written bigint,
                file_count integer,
                duration_ms integer,
                metadata jsonb,
                created_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS origin_access_grants (
                id uuid PRIMARY KEY,
                jti uuid,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                origin_id uuid NOT NULL REFERENCES workspace_origins(id) ON DELETE CASCADE,
                user_id uuid,
                lease_id uuid REFERENCES workspace_leases(id) ON DELETE SET NULL,
                scopes text[] NOT NULL DEFAULT array[]::text[],
                token_type text NOT NULL,
                issued_at timestamptz NOT NULL,
                expires_at timestamptz NOT NULL,
                issued_ip inet,
                metadata jsonb
            );

            CREATE TABLE IF NOT EXISTS runtime_tunnel_grants (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                runtime_id uuid,
                runtime_lease_id uuid REFERENCES runtime_leases(id) ON DELETE SET NULL,
                provider text NOT NULL,
                tunnel_id text NOT NULL,
                hostname text NOT NULL,
                url text NOT NULL,
                status text NOT NULL,
                expires_at timestamptz NOT NULL,
                metadata jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

       ",
        )
        .await?;
    connection_handle.abort();

    let manager =
        PostgresConnectionManager::new_from_stringlike(&url, crate::config::database_tls())
            .map_err(|error| anyhow::anyhow!("failed to create test pool manager: {error}"))?;
    let pool = bb8::Pool::builder()
        .max_size(5)
        .build(manager)
        .await
        .map_err(|error| anyhow::anyhow!("failed to build test pool: {error}"))?;

    Ok(Some(pool))
}

pub(crate) async fn require_origin_test_pool(test_name: &str) -> anyhow::Result<PgPool> {
    setup_origin_test_pool().await?.ok_or_else(|| {
        anyhow::anyhow!(
            "{test_name} requires TEST_DATABASE_URL; run it through `pnpm test:controller`"
        )
    })
}

async fn cleanup_origin_project(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute("DELETE FROM projects WHERE id = $1", &[project_id])
        .await?;
    Ok(())
}

async fn cleanup_org(pool: &PgPool, org_id: &Uuid) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute("DELETE FROM organizations WHERE id = $1", &[org_id])
        .await?;
    Ok(())
}

async fn ensure_test_user(pool: &PgPool, user_id: &Uuid) -> anyhow::Result<()> {
    let instance_id = Uuid::nil();
    let email = format!("controller-test+{}@example.com", user_id);
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into auth.users (
                instance_id,
                id,
                aud,
                role,
                email,
                encrypted_password,
                email_confirmed_at,
                last_sign_in_at,
                confirmation_token,
                recovery_token,
                email_change_token_new,
                email_change,
                raw_app_meta_data,
                raw_user_meta_data,
                is_super_admin,
                created_at,
                updated_at
            ) values (
                $1,
                $2,
                'authenticated',
                'authenticated',
                $3,
                'test-secret',
                now(),
                now(),
                '',
                '',
                '',
                '',
                '{}'::jsonb,
                '{}'::jsonb,
                false,
                now(),
                now()
            )
            on conflict (id) do nothing",
            &[&instance_id, user_id, &email],
        )
        .await?;
    Ok(())
}

async fn cleanup_test_user(pool: &PgPool, user_id: &Uuid) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute("DELETE FROM auth.users WHERE id = $1", &[user_id])
        .await?;
    Ok(())
}

#[tokio::test]
async fn project_write_policy_rejects_viewers_and_orgless_uuid_knowers() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping project write policy test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_id = Uuid::new_v4();
    let viewer_id = Uuid::new_v4();
    let outsider_id = Uuid::new_v4();
    for user_id in [owner_id, viewer_id, outsider_id] {
        ensure_test_user(&pool, &user_id).await?;
    }

    let org_id = Uuid::new_v4();
    let shared_project_id = Uuid::new_v4();
    let private_project_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Policy team')",
                &[&org_id, &format!("policy-team-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $2, $3, 'customer', 'active'),
                        ($4, null, $3, 'customer', 'active')",
                &[&shared_project_id, &org_id, &owner_id, &private_project_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'viewer')",
                &[&shared_project_id, &viewer_id],
            )
            .await?;
    }

    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let shared = load_project_record(&transaction, &shared_project_id)
        .await
        .map_err(|error| controller_error("load shared project", error))?;
    let private = load_project_record(&transaction, &private_project_id)
        .await
        .map_err(|error| controller_error("load private project", error))?;

    let viewer = RequestContext {
        user_id: Some(viewer_id),
        is_service_role: false,
        scoped_claims: None,
    };
    ensure_project_access(&transaction, &shared, &viewer, None)
        .await
        .map_err(|error| controller_error("viewer read access", error))?;
    assert!(ensure_project_scoped_write_access(
        &transaction,
        &shared,
        &viewer,
        None,
        &["fs.write"]
    )
    .await
    .is_err());

    let outsider = RequestContext {
        user_id: Some(outsider_id),
        is_service_role: false,
        scoped_claims: None,
    };
    assert!(
        ensure_project_access(&transaction, &private, &outsider, None)
            .await
            .is_err()
    );

    let owner = RequestContext {
        user_id: Some(owner_id),
        is_service_role: false,
        scoped_claims: None,
    };
    ensure_project_scoped_write_access(&transaction, &private, &owner, None, &["fs.write"])
        .await
        .map_err(|error| controller_error("private owner write access", error))?;

    let now = Utc::now().timestamp();
    let read_scoped = RequestContext {
        user_id: Some(viewer_id),
        is_service_role: false,
        scoped_claims: Some(AccessTokenClaims {
            aud: shared_project_id.to_string(),
            sub: viewer_id.to_string(),
            project_id: shared_project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: None,
            scopes: vec!["fs.read".to_string()],
            lease_id: None,
            runtime_generation: None,
            run_id: None,
            iat: now,
            exp: now + 300,
            jti: Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        }),
    };
    // The shipped hardening treats a scoped token as a capability, not a
    // project membership: generic project access must reject it so a narrow
    // token (for example fs.read) cannot reach unrelated project APIs. The
    // real read-scoped caller reaches an exact-capability endpoint instead.
    let scoped_generic_denied = ensure_project_access(&transaction, &shared, &read_scoped, None)
        .await
        .expect_err("scoped tokens must use an exact-capability endpoint, not generic access");
    assert_eq!(scoped_generic_denied.0, StatusCode::FORBIDDEN);
    assert!(ensure_project_scoped_write_access(
        &transaction,
        &shared,
        &read_scoped,
        None,
        &["fs.write"]
    )
    .await
    .is_err());

    transaction.rollback().await?;
    cleanup_origin_project(&pool, &private_project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    for user_id in [owner_id, viewer_id, outsider_id] {
        cleanup_test_user(&pool, &user_id).await?;
    }
    Ok(())
}

#[tokio::test]
async fn viewer_and_read_scoped_tokens_cannot_mint_or_acquire_write_capabilities(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping write capability endpoint test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let viewer_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &viewer_id).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Viewer policy')",
                &[&org_id, &format!("viewer-policy-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &org_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'viewer')",
                &[&project_id, &viewer_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "write-capability-policy",
    );
    let state = build_test_state(pool.clone(), config.clone());
    let user_token = crate::auth::issue_controller_token(&config, &viewer_id)
        .map_err(|error| controller_error("issue viewer token", error))?
        .token;
    let auth = format!("Bearer {user_token}");

    let lease_response = origins::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/acquire")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, &auth)
                .body(Body::from(
                    json!({ "projectId": project_id, "leaseSeconds": 90 }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(lease_response.status(), StatusCode::FORBIDDEN);

    let fs_response = origins::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/access_token")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, &auth)
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "protocol": "http",
                        "scopes": ["fs.write"],
                        "leaseId": Uuid::new_v4()
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(fs_response.status(), StatusCode::FORBIDDEN);

    let git_response = origins::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, &auth)
                .body(Body::from(json!({ "scopes": ["git.write"] }).to_string()))?,
        )
        .await?;
    assert_eq!(git_response.status(), StatusCode::FORBIDDEN);

    let runtime_response = runtime::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/runtime/token"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, &auth)
                .body(Body::from(
                    json!({ "runtimeId": Uuid::new_v4() }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(runtime_response.status(), StatusCode::FORBIDDEN);

    let integration_response = integrations::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/projects/{project_id}/integrations/github"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, &auth)
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(integration_response.status(), StatusCode::FORBIDDEN);

    let read_token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: viewer_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: None,
            scopes: vec!["fs.read".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint read-scoped token", error))?;
    let scoped_lease_response = origins::router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/acquire")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", read_token.token),
                )
                .body(Body::from(
                    json!({ "projectId": project_id, "leaseSeconds": 90 }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(scoped_lease_response.status(), StatusCode::FORBIDDEN);

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &viewer_id).await?;
    Ok(())
}

#[tokio::test]
async fn accessible_project_discovery_unions_org_and_direct_memberships() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping accessible project discovery test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let user_id = Uuid::new_v4();
    let org_member_org_id = Uuid::new_v4();
    let direct_access_org_id = Uuid::new_v4();
    let org_project_id = Uuid::new_v4();
    let direct_project_id = Uuid::new_v4();
    let sibling_project_id = Uuid::new_v4();
    let deleted_direct_project_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Member team'), ($3, $4, 'External team')",
                &[
                    &org_member_org_id,
                    &format!("member-team-{org_member_org_id}"),
                    &direct_access_org_id,
                    &format!("external-team-{direct_access_org_id}"),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'viewer')",
                &[&org_member_org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, project_type, status)
                 values ($1, $2, 'Org space', 'customer', 'active'),
                        ($3, $4, 'Directly shared space', 'customer', 'active'),
                        ($5, $4, 'Unshared sibling', 'customer', 'active'),
                        ($6, $4, 'Deleted direct space', 'customer', 'deleted')",
                &[
                    &org_project_id,
                    &org_member_org_id,
                    &direct_project_id,
                    &direct_access_org_id,
                    &sibling_project_id,
                    &deleted_direct_project_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $3, 'builder'), ($2, $3, 'viewer')",
                &[&direct_project_id, &deleted_direct_project_id, &user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "accessible-project-discovery",
    );
    let user_token = crate::auth::issue_controller_token(&config, &user_id)
        .map_err(|error| controller_error("issue project discovery token", error))?
        .token;
    let response = projects::router()
        .with_state(build_test_state(pool.clone(), config))
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/projects")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {user_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    let payload: serde_json::Value = serde_json::from_slice(&body)?;
    let discovered_projects = payload["projects"].as_array().cloned().unwrap_or_default();
    let discovered_ids = discovered_projects
        .iter()
        .filter_map(|project| {
            project
                .get("projectId")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();

    assert!(discovered_ids.contains(&org_project_id.to_string()));
    assert!(discovered_ids.contains(&direct_project_id.to_string()));
    assert!(!discovered_ids.contains(&sibling_project_id.to_string()));
    assert!(!discovered_ids.contains(&deleted_direct_project_id.to_string()));

    let org_project = discovered_projects
        .iter()
        .find(|project| project["projectId"] == org_project_id.to_string())
        .expect("organization member project should be returned");
    assert_eq!(org_project["effectiveRole"], "viewer");
    assert_eq!(org_project["canWrite"], false);
    assert_eq!(org_project["canShare"], false);
    assert_eq!(org_project["canManage"], false);

    let direct_project = discovered_projects
        .iter()
        .find(|project| project["projectId"] == direct_project_id.to_string())
        .expect("direct project member project should be returned");
    assert_eq!(direct_project["effectiveRole"], "builder");
    assert_eq!(direct_project["canWrite"], true);
    assert_eq!(direct_project["canShare"], false);
    assert_eq!(direct_project["canManage"], false);

    let direct_org_membership_count = pool
        .get()
        .await?
        .query_one(
            "select count(*) from org_memberships where org_id = $1 and user_id = $2",
            &[&direct_access_org_id, &user_id],
        )
        .await?
        .get::<_, i64>(0);
    assert_eq!(direct_org_membership_count, 0);

    cleanup_org(&pool, &direct_access_org_id).await?;
    cleanup_org(&pool, &org_member_org_id).await?;
    cleanup_test_user(&pool, &user_id).await?;
    Ok(())
}

#[tokio::test]
async fn project_member_role_changes_and_removal_publish_targeted_access_invalidations(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping project access invalidation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let member_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &member_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("project-access-invalidation-{org_id}"),
                    &"Project access invalidation",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner')",
                &[&org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Shared project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &member_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "project-access-invalidation",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue project owner token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let mut events = state.events.subscribe();
    let app = projects::router().with_state(state);

    for expected_role in ["viewer", "builder"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/projects/{project_id}/members/{member_user_id}"))
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {owner_token}"))
                    .body(Body::from(json!({ "role": expected_role }).to_string()))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let payload: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        assert_eq!(payload["member"]["role"], expected_role);

        let event = timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timed out waiting for role invalidation"))??;
        assert_eq!(event.kind, "project.access_changed");
        assert_eq!(event.project_id, Some(project_id));
        assert_eq!(event.target_user_id, Some(member_user_id));
        assert_eq!(event.data, json!({ "reason": "membership_changed" }));
    }

    let removed = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/projects/{project_id}/members/{member_user_id}"))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);

    let event = timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for removal invalidation"))??;
    assert_eq!(event.kind, "project.access_changed");
    assert_eq!(event.project_id, Some(project_id));
    assert_eq!(event.target_user_id, Some(member_user_id));
    assert_eq!(event.data, json!({ "reason": "membership_changed" }));

    let membership_count: i64 = pool
        .get()
        .await?
        .query_one(
            "select count(*) from project_memberships where project_id = $1 and user_id = $2",
            &[&project_id, &member_user_id],
        )
        .await?
        .get(0);
    assert_eq!(membership_count, 0);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &member_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn org_viewers_cannot_create_projects_but_builders_can() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping org project creation role test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let builder_user_id = Uuid::new_v4();
    let viewer_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &builder_user_id).await?;
    ensure_test_user(&pool, &viewer_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("org-project-creation-roles-{org_id}"),
                    &"Org project creation roles",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder'), ($1, $4, 'viewer')",
                &[&org_id, &owner_user_id, &builder_user_id, &viewer_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "org-project-creation-roles",
    );
    let builder_token = crate::auth::issue_controller_token(&config, &builder_user_id)
        .map_err(|error| controller_error("issue org builder token", error))?
        .token;
    let viewer_token = crate::auth::issue_controller_token(&config, &viewer_user_id)
        .map_err(|error| controller_error("issue org viewer token", error))?
        .token;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));

    let viewer_create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/projects"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {viewer_token}"),
                )
                .body(Body::from(
                    json!({ "projectName": "Viewer escalation" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(viewer_create.status(), StatusCode::FORBIDDEN);

    let builder_create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/projects"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {builder_token}"),
                )
                .body(Body::from(
                    json!({ "projectName": "Builder project" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(builder_create.status(), StatusCode::OK);
    let builder_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(builder_create.into_body(), usize::MAX).await?)?;
    let project_id = Uuid::parse_str(
        builder_payload["projectId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("project creation response omitted projectId"))?,
    )?;
    let project_owner: Option<Uuid> = pool
        .get()
        .await?
        .query_one(
            "select owner_user_id from projects where id = $1",
            &[&project_id],
        )
        .await?
        .get("owner_user_id");
    assert_eq!(project_owner, Some(builder_user_id));

    let org_projects = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/orgs/{org_id}/projects"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {viewer_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(org_projects.status(), StatusCode::OK);
    let org_projects_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(org_projects.into_body(), usize::MAX).await?)?;
    let listed_project = org_projects_payload["projects"]
        .as_array()
        .and_then(|projects| {
            projects
                .iter()
                .find(|project| project["projectId"] == project_id.to_string())
        })
        .ok_or_else(|| anyhow::anyhow!("created project missing from org project list"))?;
    assert_eq!(listed_project["effectiveRole"], "viewer");
    assert_eq!(listed_project["canWrite"], false);
    assert_eq!(listed_project["canShare"], false);
    assert_eq!(listed_project["canManage"], false);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &viewer_user_id).await?;
    cleanup_test_user(&pool, &builder_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn add_org_member_cannot_replace_an_existing_owner_role() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping add-only org member test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let admin_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &admin_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("add-only-org-member-{org_id}"),
                    &"Add-only org member",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'admin')",
                &[&org_id, &owner_user_id, &admin_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "add-only-org-member",
    );
    let admin_token = crate::auth::issue_controller_token(&config, &admin_user_id)
        .map_err(|error| controller_error("issue org admin token", error))?
        .token;
    let response = projects::router()
        .with_state(build_test_state(pool.clone(), config))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/members"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {admin_token}"),
                )
                .body(Body::from(
                    json!({ "userId": owner_user_id, "role": "viewer" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    assert_eq!(payload["code"], "org_member_exists");

    let connection = pool.get().await?;
    let owner_role: String = connection
        .query_one(
            "select role from org_memberships where org_id = $1 and user_id = $2",
            &[&org_id, &owner_user_id],
        )
        .await?
        .get("role");
    let owner_count: i64 = connection
        .query_one(
            "select count(*) from org_memberships where org_id = $1 and role = 'owner'",
            &[&org_id],
        )
        .await?
        .get(0);
    drop(connection);
    assert_eq!(owner_role, "owner");
    assert_eq!(owner_count, 1);

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &admin_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn concurrent_owner_removal_and_demotion_preserve_one_owner() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping concurrent owner mutation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let demoted_user_id = Uuid::new_v4();
    let removed_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    ensure_test_user(&pool, &demoted_user_id).await?;
    ensure_test_user(&pool, &removed_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("concurrent-owner-mutation-{org_id}"),
                    &"Concurrent owner mutation",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'owner')",
                &[&org_id, &demoted_user_id, &removed_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "concurrent-owner-mutation",
    );
    let demoted_user_token = crate::auth::issue_controller_token(&config, &demoted_user_id)
        .map_err(|error| controller_error("issue demoted owner token", error))?
        .token;
    let removed_user_token = crate::auth::issue_controller_token(&config, &removed_user_id)
        .map_err(|error| controller_error("issue removed owner token", error))?
        .token;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));
    let start = Arc::new(tokio::sync::Barrier::new(2));

    let demote = {
        let app = app.clone();
        let start = start.clone();
        async move {
            start.wait().await;
            app.oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/orgs/{org_id}/members/{demoted_user_id}"))
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {demoted_user_token}"))
                    .body(Body::from(json!({ "role": "viewer" }).to_string()))
                    .expect("build concurrent owner demotion request"),
            )
            .await
        }
    };
    let remove = {
        let app = app.clone();
        let start = start.clone();
        async move {
            start.wait().await;
            app.oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/orgs/{org_id}/members/{removed_user_id}"))
                    .header("authorization", format!("Bearer {removed_user_token}"))
                    .body(Body::empty())
                    .expect("build concurrent owner removal request"),
            )
            .await
        }
    };

    let (demote_response, remove_response) = tokio::join!(demote, remove);
    let statuses = [demote_response?.status(), remove_response?.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK || **status == StatusCode::NO_CONTENT)
            .count(),
        1,
        "exactly one owner mutation should succeed: {statuses:?}"
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::BAD_REQUEST)
            .count(),
        1,
        "the second mutation should reject removal of the last owner: {statuses:?}"
    );

    let connection = pool.get().await?;
    let owner_count: i64 = connection
        .query_one(
            "select count(*) from org_memberships where org_id = $1 and role = 'owner'",
            &[&org_id],
        )
        .await?
        .get(0);
    drop(connection);
    assert_eq!(owner_count, 1);

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &removed_user_id).await?;
    cleanup_test_user(&pool, &demoted_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn scoped_plan_group_status_is_bound_to_token_run_and_conversation() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping scoped plan group status test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;

    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_a = Uuid::new_v4();
    let conversation_b = Uuid::new_v4();
    let group_a = Uuid::new_v4();
    let group_b = Uuid::new_v4();
    let run_a = Uuid::new_v4();
    let run_b = Uuid::new_v4();
    let run_c = Uuid::new_v4();
    let job_a = Uuid::new_v4();
    let job_b = Uuid::new_v4();
    let job_c = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let runtime_lease_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .batch_execute(
                "alter table agent_jobs add column if not exists plan_group_id uuid;
                 alter table agent_jobs add column if not exists agent_role text;",
            )
            .await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("scoped-plan-status-{org_id}"),
                    &"Scoped plan status",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $2, $3, 'customer', 'active')",
                &[&project_id, &org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status)
                 values ($1, $2, 'default', 'running')",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (id, project_id, runtime_id, status, launched_at)
                 values ($1, $2, $3, 'active', now())",
                &[&runtime_lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &runtime_lease_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $3, $4, '{}'::jsonb, 'private'),
                        ($2, $3, $4, '{}'::jsonb, 'private')",
                &[&conversation_a, &conversation_b, &project_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $4, $5, 'prompt', 'in_progress'),
                        ($2, $4, $6, 'prompt', 'in_progress'),
                        ($3, $4, $6, 'prompt', 'in_progress')",
                &[
                    &run_a,
                    &run_b,
                    &run_c,
                    &project_id,
                    &conversation_a,
                    &conversation_b,
                ],
            )
            .await?;

        for (job_id, run_id, conversation_id, group_id) in [
            (job_a, run_a, conversation_a, group_a),
            (job_b, run_b, conversation_b, group_b),
            (job_c, run_c, conversation_b, group_a),
        ] {
            let payload = PgJson(json!({
                "user_id": user_id,
                "metadata": {
                    "multiAgentPlan": {
                        "groupId": group_id,
                        "role": "worker"
                    }
                }
            }));
            connection
                .execute(
                    "insert into agent_jobs (
                        id, project_id, run_id, conversation_id, status, payload,
                        plan_group_id, agent_role, leased_by_runtime_id, leased_at,
                        lease_expires_at
                     ) values ($1, $2, $3, $4, 'leased', $5, $6, 'worker', $7,
                               now(), now() + interval '5 minutes')",
                    &[
                        &job_id,
                        &project_id,
                        &run_id,
                        &conversation_id,
                        &payload,
                        &group_id,
                        &runtime_id,
                    ],
                )
                .await?;
        }
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "scoped-plan-group-status",
    );
    let token_for_run = |run_id: Option<Uuid>,
                         lease_id: Option<Uuid>,
                         generation_marked: bool|
     -> anyhow::Result<String> {
        let mut scopes = vec!["prompt.execute".to_string()];
        if generation_marked {
            scopes.push("job.token.workspace-separated".to_string());
        }
        Ok(mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: user_id.to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes,
                lease_id: lease_id.map(|value| value.to_string()),
                run_id: run_id.map(|value| value.to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|(_, AxumJson(error))| anyhow::anyhow!(error.message))?
        .token)
    };
    let token_a = token_for_run(Some(run_a), Some(runtime_lease_id), true)?;
    let legacy_lease_less_token_a = token_for_run(Some(run_a), None, false)?;
    let stale_generation_token_a = token_for_run(Some(run_a), Some(Uuid::new_v4()), true)?;
    let token_c = token_for_run(Some(run_c), Some(runtime_lease_id), true)?;
    let token_without_run = token_for_run(None, Some(runtime_lease_id), true)?;
    let app = crate::agent::router().with_state(build_test_state(pool.clone(), config));

    let allowed_a = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_a}/status"))
                .header("authorization", format!("Bearer {token_a}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(allowed_a.status(), StatusCode::OK);
    let allowed_a_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(allowed_a.into_body(), usize::MAX).await?)?;
    assert_eq!(allowed_a_payload["conversationId"], json!(conversation_a));
    assert_eq!(
        allowed_a_payload["workers"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(allowed_a_payload["workers"][0]["jobId"], json!(job_a));

    let allowed_legacy_lease_less = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_a}/status"))
                .header(
                    "authorization",
                    format!("Bearer {legacy_lease_less_token_a}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(allowed_legacy_lease_less.status(), StatusCode::OK);

    let denied_stale_generation = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_a}/status"))
                .header(
                    "authorization",
                    format!("Bearer {stale_generation_token_a}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_stale_generation.status(), StatusCode::UNAUTHORIZED);

    let denied_other_group = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_b}/status"))
                .header("authorization", format!("Bearer {token_a}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_other_group.status(), StatusCode::NOT_FOUND);

    let allowed_same_group_other_conversation = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_a}/status"))
                .header("authorization", format!("Bearer {token_c}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(
        allowed_same_group_other_conversation.status(),
        StatusCode::OK
    );
    let conversation_b_payload: serde_json::Value = serde_json::from_slice(
        &to_bytes(
            allowed_same_group_other_conversation.into_body(),
            usize::MAX,
        )
        .await?,
    )?;
    assert_eq!(
        conversation_b_payload["conversationId"],
        json!(conversation_b)
    );
    assert_eq!(
        conversation_b_payload["workers"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(conversation_b_payload["workers"][0]["jobId"], json!(job_c));

    let denied_missing_run = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_a}/status"))
                .header("authorization", format!("Bearer {token_without_run}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_missing_run.status(), StatusCode::UNAUTHORIZED);

    let wrong_runtime_owner = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "update runtimes
             set provider = 'self-hosted', capabilities = $2
             where id = $1",
            &[
                &runtime_id,
                &PgJson(json!({
                    "_instafySelfHostedAccess": {
                        "mode": "private",
                        "ownerUserId": wrong_runtime_owner.to_string(),
                    }
                })),
            ],
        )
        .await?;
    let denied_private_runtime = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_a}/status"))
                .header("authorization", format!("Bearer {token_a}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_private_runtime.status(), StatusCode::UNAUTHORIZED);
    let denied_private_runtime: serde_json::Value =
        serde_json::from_slice(&to_bytes(denied_private_runtime.into_body(), usize::MAX).await?)?;
    assert_eq!(
        denied_private_runtime["message"],
        "job token subject does not own the private self-hosted runtime"
    );

    pool.get()
        .await?
        .execute(
            "update runtimes set capabilities = $2 where id = $1",
            &[
                &runtime_id,
                &PgJson(json!({
                    "_instafySelfHostedAccess": {
                        "mode": "private",
                        "ownerUserId": user_id.to_string(),
                    }
                })),
            ],
        )
        .await?;
    let allowed_private_runtime_owner = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/agent/plan-groups/{group_a}/status"))
                .header("authorization", format!("Bearer {token_a}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(allowed_private_runtime_owner.status(), StatusCode::OK);

    pool.get()
        .await?
        .execute(
            "delete from runs where id in ($1, $2, $3)",
            &[&run_a, &run_b, &run_c],
        )
        .await?;
    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &user_id).await?;
    Ok(())
}

#[tokio::test]
async fn bug_report_creation_authorizes_project_and_linked_resources() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping bug report resource authorization test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;

    let reporter_user_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let allowed_org_id = Uuid::new_v4();
    let other_org_id = Uuid::new_v4();
    let allowed_project_id = Uuid::new_v4();
    let other_project_id = Uuid::new_v4();
    let public_conversation_id = Uuid::new_v4();
    let private_conversation_id = Uuid::new_v4();
    let other_conversation_id = Uuid::new_v4();
    let public_run_id = Uuid::new_v4();
    let private_run_id = Uuid::new_v4();
    let other_run_id = Uuid::new_v4();
    let allowed_runtime_id = Uuid::new_v4();
    let other_runtime_id = Uuid::new_v4();
    ensure_test_user(&pool, &reporter_user_id).await?;
    ensure_test_user(&pool, &owner_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Bug report project'), ($3, $4, 'Other bug report project')",
                &[
                    &allowed_org_id,
                    &format!("bug-report-project-{allowed_org_id}"),
                    &other_org_id,
                    &format!("bug-report-other-{other_org_id}"),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $3, 'owner'), ($2, $3, 'owner')",
                &[&allowed_org_id, &other_org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $2, $5, 'customer', 'active'),
                        ($3, $4, $5, 'customer', 'active')",
                &[
                    &allowed_project_id,
                    &allowed_org_id,
                    &other_project_id,
                    &other_org_id,
                    &owner_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'viewer')",
                &[&allowed_project_id, &reporter_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $4, $6, '{}'::jsonb, 'public'),
                        ($2, $4, $6, '{}'::jsonb, 'private'),
                        ($3, $5, $6, '{}'::jsonb, 'public')",
                &[
                    &public_conversation_id,
                    &private_conversation_id,
                    &other_conversation_id,
                    &allowed_project_id,
                    &other_project_id,
                    &owner_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $4, $6, 'prompt', 'in_progress'),
                        ($2, $4, $7, 'prompt', 'in_progress'),
                        ($3, $5, $8, 'prompt', 'in_progress')",
                &[
                    &public_run_id,
                    &private_run_id,
                    &other_run_id,
                    &allowed_project_id,
                    &other_project_id,
                    &public_conversation_id,
                    &private_conversation_id,
                    &other_conversation_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status)
                 values ($1, $3, 'test', 'ready'), ($2, $4, 'test', 'ready')",
                &[
                    &allowed_runtime_id,
                    &other_runtime_id,
                    &allowed_project_id,
                    &other_project_id,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "bug-report-resource-authorization",
    );
    let reporter_token = crate::auth::issue_controller_token(&config, &reporter_user_id)
        .map_err(|error| controller_error("issue bug report reporter token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let mut events_rx = state.events.subscribe();
    let app = crate::bug_reports::router().with_state(state);

    for (body, expected_status) in [
        (
            json!({
                "message": "Missing project",
                "runtimeId": allowed_runtime_id
            }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({
                "message": "Unauthorized project",
                "projectId": other_project_id
            }),
            StatusCode::FORBIDDEN,
        ),
        (
            json!({
                "message": "Cross-project conversation",
                "projectId": allowed_project_id,
                "conversationId": other_conversation_id
            }),
            StatusCode::NOT_FOUND,
        ),
        (
            json!({
                "message": "Cross-project run",
                "projectId": allowed_project_id,
                "runId": other_run_id
            }),
            StatusCode::NOT_FOUND,
        ),
        (
            json!({
                "message": "Cross-project runtime",
                "projectId": allowed_project_id,
                "runtimeId": other_runtime_id
            }),
            StatusCode::NOT_FOUND,
        ),
        (
            json!({
                "message": "Private conversation",
                "projectId": allowed_project_id,
                "conversationId": private_conversation_id
            }),
            StatusCode::FORBIDDEN,
        ),
        (
            json!({
                "message": "Run in private conversation",
                "projectId": allowed_project_id,
                "runId": private_run_id
            }),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/bug-reports")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {reporter_token}"),
                    )
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        assert_eq!(response.status(), expected_status, "request body: {body}");
    }

    let created = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/bug-reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_token}"),
                )
                .body(Body::from(
                    json!({
                        "message": "Authorized project context",
                        "details": "Sensitive support details",
                        "projectId": allowed_project_id,
                        "conversationId": public_conversation_id,
                        "runId": public_run_id,
                        "runtimeId": allowed_runtime_id
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await?)?;
    let bug_report_id = Uuid::parse_str(
        created_payload["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("bug report response omitted id"))?,
    )?;

    assert!(
        timeout(std::time::Duration::from_millis(100), events_rx.recv())
            .await
            .is_err(),
        "customer bug reports must not be broadcast to project event subscribers"
    );

    let stored = pool
        .get()
        .await?
        .query_one(
            "select user_id, project_id, conversation_id, run_id, runtime_id
             from bug_reports where id = $1",
            &[&bug_report_id],
        )
        .await?;
    assert_eq!(
        stored.get::<_, Option<Uuid>>("user_id"),
        Some(reporter_user_id)
    );
    assert_eq!(
        stored.get::<_, Option<Uuid>>("project_id"),
        Some(allowed_project_id)
    );
    assert_eq!(
        stored.get::<_, Option<Uuid>>("conversation_id"),
        Some(public_conversation_id)
    );
    assert_eq!(stored.get::<_, Option<Uuid>>("run_id"), Some(public_run_id));
    assert_eq!(
        stored.get::<_, Option<Uuid>>("runtime_id"),
        Some(allowed_runtime_id)
    );

    {
        let connection = pool.get().await?;
        connection
            .execute("delete from bug_reports where id = $1", &[&bug_report_id])
            .await?;
        connection
            .execute(
                "delete from runs where id in ($1, $2, $3)",
                &[&public_run_id, &private_run_id, &other_run_id],
            )
            .await?;
    }
    cleanup_origin_project(&pool, &other_project_id).await?;
    cleanup_origin_project(&pool, &allowed_project_id).await?;
    cleanup_org(&pool, &other_org_id).await?;
    cleanup_org(&pool, &allowed_org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &reporter_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn support_report_routes_enforce_customer_privacy_boundary() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("support report route privacy test").await?;

    fn assert_exact_json_keys(value: &serde_json::Value, expected: &[&str], label: &str) {
        let mut actual = value
            .as_object()
            .unwrap_or_else(|| panic!("{label} must be a JSON object"))
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        actual.sort_unstable();
        let mut expected = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(actual, expected, "{label} field boundary changed");
    }

    let reporter_a_id = Uuid::new_v4();
    let reporter_b_id = Uuid::new_v4();
    ensure_test_user(&pool, &reporter_a_id).await?;
    ensure_test_user(&pool, &reporter_b_id).await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "support-report-privacy-boundary",
    );
    let reporter_a_token = crate::auth::issue_controller_token(&config, &reporter_a_id)
        .map_err(|error| controller_error("issue support reporter A token", error))?
        .token;
    let reporter_b_token = crate::auth::issue_controller_token(&config, &reporter_b_id)
        .map_err(|error| controller_error("issue support reporter B token", error))?
        .token;
    let runtime_id = Uuid::new_v4();
    let scoped_token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: runtime_id.to_string(),
            subject: reporter_a_id.to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: vec!["telemetry.write".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint scoped support rejection token", error))?
    .token;
    let app = crate::bug_reports::router().with_state(build_test_state(pool.clone(), config));

    let png_signature = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let create_a = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_a_token}"),
                )
                .body(Body::from(
                    json!({
                        "message": "Reporter A support issue",
                        "details": "Details submitted by reporter A",
                        "metadata": { "customerContext": "submitted" },
                        "logs": [{ "message": "customer diagnostic" }],
                        "screenshots": [{
                            "fileName": "screen.png",
                            "mediaType": "image/png",
                            "dataBase64": STANDARD.encode(&png_signature),
                            "byteLength": png_signature.len()
                        }]
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(create_a.status(), StatusCode::CREATED);
    let create_a_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(create_a.into_body(), usize::MAX).await?)?;
    let report_a_id = Uuid::parse_str(
        create_a_payload["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("support create response omitted report A id"))?,
    )?;

    let create_b = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_b_token}"),
                )
                .body(Body::from(
                    json!({ "message": "Reporter B support issue" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(create_b.status(), StatusCode::CREATED);
    let create_b_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(create_b.into_body(), usize::MAX).await?)?;
    let report_b_id = Uuid::parse_str(
        create_b_payload["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("support create response omitted report B id"))?,
    )?;

    pool.get()
        .await?
        .execute(
            "update bug_reports
                set priority = 'urgent',
                    assignee = 'internal-operator',
                    labels = '[\"security\"]'::jsonb,
                    github_issue_url = 'https://example.invalid/internal/123',
                    metadata = '{\"triageSecret\":\"internal-only\"}'::jsonb,
                    logs = '[{\"secret\":\"internal-only\"}]'::jsonb,
                    updated_at = now()
              where id = $1",
            &[&report_a_id],
        )
        .await?;

    let list_a = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/support/reports?mine=false&limit=100")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_a_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(list_a.status(), StatusCode::OK);
    let list_a_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(list_a.into_body(), usize::MAX).await?)?;
    let reporter_a_reports = list_a_payload["reports"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("support list response omitted reports"))?;
    assert_eq!(reporter_a_reports.len(), 1);
    assert_eq!(reporter_a_reports[0]["id"], report_a_id.to_string());
    assert_ne!(reporter_a_reports[0]["id"], report_b_id.to_string());
    assert_eq!(reporter_a_reports[0]["screenshotCount"], 1);
    assert_exact_json_keys(
        &reporter_a_reports[0],
        &[
            "id",
            "createdAt",
            "updatedAt",
            "message",
            "status",
            "projectId",
            "screenshotCount",
        ],
        "customer support list item",
    );

    let show_a = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/support/reports/{report_a_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_a_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(show_a.status(), StatusCode::OK);
    let show_a_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(show_a.into_body(), usize::MAX).await?)?;
    assert_eq!(show_a_payload["id"], report_a_id.to_string());
    assert_eq!(show_a_payload["details"], "Details submitted by reporter A");
    assert_exact_json_keys(
        &show_a_payload,
        &[
            "id",
            "createdAt",
            "updatedAt",
            "message",
            "details",
            "status",
            "projectId",
            "runtimeId",
            "runId",
            "conversationId",
            "screenshots",
        ],
        "customer support detail",
    );
    let customer_attachments = show_a_payload["screenshots"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("support detail omitted attachment descriptors"))?;
    assert_eq!(customer_attachments.len(), 1);
    assert_eq!(customer_attachments[0]["fileName"], "screen.png");
    assert_eq!(customer_attachments[0]["mediaType"], "image/png");
    assert_eq!(customer_attachments[0]["byteSize"], png_signature.len());
    assert_exact_json_keys(
        &customer_attachments[0],
        &["id", "fileName", "mediaType", "byteSize"],
        "customer support attachment",
    );

    let cross_customer_show = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/support/reports/{report_b_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_a_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(cross_customer_show.status(), StatusCode::NOT_FOUND);

    let service_support_list = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/support/reports")
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(service_support_list.status(), StatusCode::UNAUTHORIZED);

    let service_support_create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::from(
                    json!({ "message": "must not be accepted" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(service_support_create.status(), StatusCode::UNAUTHORIZED);

    let scoped_support_list = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/support/reports")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {scoped_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(scoped_support_list.status(), StatusCode::UNAUTHORIZED);

    let legacy_customer_show = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/bug-reports/{report_a_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_a_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(legacy_customer_show.status(), StatusCode::OK);
    let legacy_customer_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(legacy_customer_show.into_body(), usize::MAX).await?)?;
    assert_exact_json_keys(
        &legacy_customer_payload,
        &[
            "id",
            "createdAt",
            "updatedAt",
            "message",
            "details",
            "status",
            "projectId",
            "runtimeId",
            "runId",
            "conversationId",
            "screenshots",
        ],
        "legacy customer bug report detail",
    );
    assert_exact_json_keys(
        &legacy_customer_payload["screenshots"][0],
        &["id", "fileName", "mediaType", "byteSize"],
        "legacy customer bug report attachment",
    );

    let operator_show = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/bug-reports/{report_a_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(operator_show.status(), StatusCode::OK);
    let operator_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(operator_show.into_body(), usize::MAX).await?)?;
    assert_eq!(operator_payload["priority"], "urgent");
    assert_eq!(operator_payload["assignee"], "internal-operator");
    assert_eq!(
        operator_payload["metadata"]["triageSecret"],
        "internal-only"
    );
    assert_eq!(operator_payload["logs"][0]["secret"], "internal-only");
    assert_eq!(
        operator_payload["screenshots"][0]["dataBase64"],
        STANDARD.encode(&png_signature)
    );

    pool.get()
        .await?
        .execute(
            "delete from bug_reports where id in ($1, $2)",
            &[&report_a_id, &report_b_id],
        )
        .await?;
    cleanup_test_user(&pool, &reporter_b_id).await?;
    cleanup_test_user(&pool, &reporter_a_id).await?;
    Ok(())
}

#[tokio::test]
async fn bug_report_operator_allowlist_grants_only_bug_report_routes() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("bug report operator allowlist test").await?;

    let reporter_id = Uuid::new_v4();
    let bug_report_operator_id = Uuid::new_v4();
    ensure_test_user(&pool, &reporter_id).await?;
    ensure_test_user(&pool, &bug_report_operator_id).await?;

    // The bug-reports-only role must work on its own: no operator org and no
    // full operator allowlist are configured here.
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "bug-report-operator-allowlist",
    );
    config.operator_console_org_id = None;
    config.operator_console_allowed_user_ids = vec![];
    config.bug_reports_operator_user_ids = vec![bug_report_operator_id];

    let reporter_token = crate::auth::issue_controller_token(&config, &reporter_id)
        .map_err(|error| controller_error("issue bug report reporter token", error))?
        .token;
    let bug_report_operator_token =
        crate::auth::issue_controller_token(&config, &bug_report_operator_id)
            .map_err(|error| controller_error("issue bug report operator token", error))?
            .token;
    let scoped_runtime_id = Uuid::new_v4();
    let bug_report_operator_scoped_token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: scoped_runtime_id.to_string(),
            subject: bug_report_operator_id.to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: None,
            runtime_id: Some(scoped_runtime_id.to_string()),
            protocol: None,
            scopes: vec!["telemetry.write".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint scoped bug report operator token", error))?
    .token;

    let state = build_test_state(pool.clone(), config);
    let app = crate::bug_reports::router().with_state(state.clone());
    let operator_admin_app = crate::operator_admin::router().with_state(state.clone());
    let ota_app = crate::ota::router().with_state(state);

    let unique_message = format!("Allowlist triage {}", Uuid::new_v4());
    let png_signature = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_token}"),
                )
                .body(Body::from(
                    json!({
                        "message": unique_message,
                        "details": "Details from the reporter",
                        "screenshots": [{
                            "fileName": "screen.png",
                            "mediaType": "image/png",
                            "dataBase64": STANDARD.encode(&png_signature),
                            "byteLength": png_signature.len()
                        }]
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(create.status(), StatusCode::CREATED);
    let create_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(create.into_body(), usize::MAX).await?)?;
    let report_id = Uuid::parse_str(
        create_payload["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("support create response omitted report id"))?,
    )?;

    pool.get()
        .await?
        .execute(
            "update bug_reports
                set priority = 'urgent',
                    metadata = '{\"triageSecret\":\"internal-only\"}'::jsonb,
                    logs = '[{\"secret\":\"internal-only\"}]'::jsonb,
                    updated_at = now()
              where id = $1",
            &[&report_id],
        )
        .await?;

    // A user in BUG_REPORTS_OPERATOR_USER_IDS gets the operator projection on list,
    // including reports filed by other users and the internal triage fields.
    let operator_list = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/bug-reports?limit=100&search={}",
                    urlencoding::encode(&unique_message)
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bug_report_operator_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(operator_list.status(), StatusCode::OK);
    let operator_list_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(operator_list.into_body(), usize::MAX).await?)?;
    let operator_reports = operator_list_payload["reports"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("operator list response omitted reports"))?;
    let listed = operator_reports
        .iter()
        .find(|report| report["id"] == report_id.to_string())
        .ok_or_else(|| {
            anyhow::anyhow!("bug-report operator must see reports filed by other users")
        })?;
    assert_eq!(listed["priority"], "urgent");
    assert_eq!(listed["userId"], reporter_id.to_string());
    assert_eq!(listed["metadata"]["triageSecret"], "internal-only");
    assert_eq!(listed["screenshotCount"], 1);

    // ...the full detail on get...
    let operator_show = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/bug-reports/{report_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bug_report_operator_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(operator_show.status(), StatusCode::OK);
    let operator_show_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(operator_show.into_body(), usize::MAX).await?)?;
    assert_eq!(operator_show_payload["id"], report_id.to_string());
    assert_eq!(operator_show_payload["priority"], "urgent");
    assert_eq!(operator_show_payload["userId"], reporter_id.to_string());
    assert_eq!(
        operator_show_payload["metadata"]["triageSecret"],
        "internal-only"
    );
    assert_eq!(operator_show_payload["logs"][0]["secret"], "internal-only");
    assert_eq!(
        operator_show_payload["screenshots"][0]["dataBase64"],
        STANDARD.encode(&png_signature)
    );

    // ...and can PATCH triage fields.
    let operator_patch = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/bug-reports/{report_id}"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bug_report_operator_token}"),
                )
                .body(Body::from(
                    json!({ "status": "in_progress", "assignee": "bug-report-operator" })
                        .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(operator_patch.status(), StatusCode::OK);
    let operator_patch_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(operator_patch.into_body(), usize::MAX).await?)?;
    assert_eq!(operator_patch_payload["id"], report_id.to_string());
    assert_eq!(operator_patch_payload["status"], "in_progress");
    assert_eq!(operator_patch_payload["assignee"], "bug-report-operator");

    // The role authenticates like the full operator gate: a runtime-scoped token
    // for the same user is not an interactive operator session.
    let scoped_patch = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/bug-reports/{report_id}"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bug_report_operator_scoped_token}"),
                )
                .body(Body::from(json!({ "status": "resolved" }).to_string()))?,
        )
        .await?;
    assert_eq!(scoped_patch.status(), StatusCode::FORBIDDEN);

    // The same user is refused on operator-only routes outside bug reports.
    let operator_search = operator_admin_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/operator/projects/search?q=allowlist&limit=10")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bug_report_operator_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(operator_search.status(), StatusCode::FORBIDDEN);

    let ota_releases = ota_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/ota/releases")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bug_report_operator_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(ota_releases.status(), StatusCode::FORBIDDEN);

    // A user in neither list still gets the customer projection and cannot PATCH.
    let customer_list = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/bug-reports?limit=100")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(customer_list.status(), StatusCode::OK);
    let customer_list_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(customer_list.into_body(), usize::MAX).await?)?;
    let customer_reports = customer_list_payload["reports"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("customer list response omitted reports"))?;
    assert_eq!(customer_reports.len(), 1);
    assert_eq!(customer_reports[0]["id"], report_id.to_string());
    assert_eq!(customer_reports[0]["status"], "in_progress");
    for operator_only_key in ["priority", "assignee", "metadata", "logs", "userId"] {
        assert!(
            customer_reports[0].get(operator_only_key).is_none(),
            "customer list projection leaked {operator_only_key}"
        );
    }

    let customer_show = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/bug-reports/{report_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(customer_show.status(), StatusCode::OK);
    let customer_show_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(customer_show.into_body(), usize::MAX).await?)?;
    assert_eq!(customer_show_payload["id"], report_id.to_string());
    for operator_only_key in ["priority", "assignee", "metadata", "logs", "userId"] {
        assert!(
            customer_show_payload.get(operator_only_key).is_none(),
            "customer detail projection leaked {operator_only_key}"
        );
    }
    assert!(customer_show_payload["screenshots"][0]
        .get("dataBase64")
        .is_none());

    let customer_patch = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/bug-reports/{report_id}"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {reporter_token}"),
                )
                .body(Body::from(json!({ "status": "resolved" }).to_string()))?,
        )
        .await?;
    assert_eq!(customer_patch.status(), StatusCode::FORBIDDEN);

    pool.get()
        .await?
        .execute("delete from bug_reports where id = $1", &[&report_id])
        .await?;
    cleanup_test_user(&pool, &bug_report_operator_id).await?;
    cleanup_test_user(&pool, &reporter_id).await?;
    Ok(())
}

#[tokio::test]
async fn support_report_routes_enforce_request_and_daily_limits() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("support report request limit test").await?;
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "support-report-request-limits",
    );
    let quota_user_id = Uuid::new_v4();
    let malformed_user_id = Uuid::new_v4();
    let large_body_user_id = Uuid::new_v4();
    let quota_user_token = crate::auth::issue_controller_token(&config, &quota_user_id)
        .map_err(|error| controller_error("issue support quota token", error))?
        .token;
    let malformed_user_token = crate::auth::issue_controller_token(&config, &malformed_user_id)
        .map_err(|error| controller_error("issue support malformed-body token", error))?
        .token;
    let large_body_user_token = crate::auth::issue_controller_token(&config, &large_body_user_id)
        .map_err(|error| controller_error("issue support large-body token", error))?
        .token;
    let app = crate::bug_reports::router().with_state(build_test_state(pool.clone(), config));

    let initial_quota_report = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {quota_user_token}"),
                )
                .body(Body::from(
                    json!({ "message": "Daily quota seed" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(initial_quota_report.status(), StatusCode::CREATED);

    {
        let connection = pool.get().await?;
        for ordinal in 1..20 {
            connection
                .execute(
                    "insert into bug_reports (id, user_id, message, created_at)
                     values ($1, $2, $3, now())",
                    &[
                        &Uuid::new_v4(),
                        &quota_user_id,
                        &format!("Daily quota seed {ordinal}"),
                    ],
                )
                .await?;
        }
    }

    let daily_quota_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {quota_user_token}"),
                )
                .body(Body::from(
                    json!({ "message": "Must exceed daily quota" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(daily_quota_response.status(), StatusCode::TOO_MANY_REQUESTS);

    for attempt in 1..=6 {
        let malformed_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/support/reports")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {malformed_user_token}"),
                    )
                    .body(Body::from("{"))?,
            )
            .await?;
        assert_eq!(
            malformed_response.status(),
            if attempt <= 5 {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::TOO_MANY_REQUESTS
            },
            "unexpected status for malformed support attempt {attempt}"
        );
    }

    let oversized_body = vec![b'x'; 20 * 1024 * 1024 + 1];
    let oversized_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {large_body_user_token}"),
                )
                .body(Body::from(oversized_body))?,
        )
        .await?;
    assert_eq!(oversized_response.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let anonymous_oversized_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/support/reports")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(vec![b'x'; 20 * 1024 * 1024 + 1]))?,
        )
        .await?;
    assert_eq!(
        anonymous_oversized_response.status(),
        StatusCode::UNAUTHORIZED,
        "support route must authenticate before buffering a large request body"
    );

    pool.get()
        .await?
        .execute(
            "delete from bug_reports where user_id = $1",
            &[&quota_user_id],
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn project_roles_gate_write_credentials_and_scoped_token_exchanges() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping project role authorization test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let builder_user_id = Uuid::new_v4();
    let viewer_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let runtime_lease_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &builder_user_id).await?;
    ensure_test_user(&pool, &viewer_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("project-role-gates-{org_id}"),
                    &"Project role gates",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder'), ($1, $4, 'viewer')",
                &[&org_id, &owner_user_id, &builder_user_id, &viewer_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Permission test', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                 values ($1, $2, 'desktop', 'https://permission-test-origin', ARRAY['webdav']::text[])",
                &[&origin_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, capabilities)
                 values ($1, $2, 'instafy-cloud', 'ready', '{}'::jsonb)",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) values ($1, $2, $3, 'active', now(), now())",
                &[&runtime_lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &runtime_lease_id],
            )
            .await?;
        connection
            .execute(
                "insert into origin_instances (
                     id, project_id, runtime_id, origin_id, required, mode, status,
                     endpoint, protocols, metadata
                 ) values (
                     $1, $2, $3, $4, true, 'desktop', 'online',
                     'https://permission-test-origin', ARRAY['webdav']::text[], '{}'::jsonb
                 )",
                &[&Uuid::new_v4(), &project_id, &runtime_id, &origin_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "project-role-gates",
    );
    let builder_token = crate::auth::issue_controller_token(&config, &builder_user_id)
        .map_err(|error| controller_error("issue builder token", error))?
        .token;
    let viewer_token = crate::auth::issue_controller_token(&config, &viewer_user_id)
        .map_err(|error| controller_error("issue viewer token", error))?
        .token;
    let scoped_read_token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: origin_id.to_string(),
            subject: owner_user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: None,
            protocol: Some("webdav".to_string()),
            scopes: vec!["fs.read".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint scoped read token", error))?
    .token;
    let runtime_capability_token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: owner_user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: vec![
                crate::runtime::RUNTIME_TOKEN_GIT_MINT_SCOPE.to_string(),
                crate::runtime::RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE.to_string(),
            ],
            lease_id: Some(runtime_lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint runtime capability token", error))?
    .token;
    let legacy_runtime_token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: owner_user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: crate::runtime::RUNTIME_TOKEN_DEFAULT_SCOPES
                .iter()
                .map(|scope| scope.to_string())
                .collect(),
            lease_id: Some(runtime_lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint legacy runtime token", error))?
    .token;
    let state = build_test_state(pool.clone(), config.clone());

    let project_app = projects::router().with_state(state.clone());
    let viewer_summary = project_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}"))
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(viewer_summary.status(), StatusCode::OK);
    let viewer_summary: serde_json::Value =
        serde_json::from_slice(&to_bytes(viewer_summary.into_body(), usize::MAX).await?)?;
    assert_eq!(viewer_summary["effectiveRole"], "viewer");
    assert_eq!(viewer_summary["canWrite"], false);
    assert_eq!(viewer_summary["canShare"], false);
    assert_eq!(viewer_summary["canManage"], false);

    let builder_summary = project_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}"))
                .header("authorization", format!("Bearer {builder_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(builder_summary.status(), StatusCode::OK);
    let builder_summary: serde_json::Value =
        serde_json::from_slice(&to_bytes(builder_summary.into_body(), usize::MAX).await?)?;
    assert_eq!(builder_summary["effectiveRole"], "builder");
    assert_eq!(builder_summary["canWrite"], true);
    assert_eq!(builder_summary["canShare"], true);
    assert_eq!(builder_summary["canManage"], false);

    let scoped_settings = project_app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/projects/{project_id}"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {scoped_read_token}"))
                .body(Body::from(
                    json!({ "projectName": "Escalated" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(scoped_settings.status(), StatusCode::FORBIDDEN);

    let scoped_invite = project_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/invite-links"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {scoped_read_token}"))
                .body(Body::from(
                    json!({ "projectId": project_id, "role": "viewer" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(scoped_invite.status(), StatusCode::FORBIDDEN);

    for uri in ["/projects", "/orgs"] {
        let scoped_list = project_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .header("authorization", format!("Bearer {scoped_read_token}"))
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(scoped_list.status(), StatusCode::FORBIDDEN);
    }

    let origin_app = crate::origins::router().with_state(state.clone());
    let scoped_read = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header("authorization", format!("Bearer {scoped_read_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(scoped_read.status(), StatusCode::OK);

    let runtime_lease_read = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header(
                    "authorization",
                    format!("Bearer {runtime_capability_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(runtime_lease_read.status(), StatusCode::OK);

    let viewer_lease = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/acquire")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::from(
                    json!({ "projectId": project_id, "runtimeId": runtime_id }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(viewer_lease.status(), StatusCode::FORBIDDEN);

    let builder_lease = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/acquire")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {builder_token}"))
                .body(Body::from(
                    json!({ "projectId": project_id, "runtimeId": runtime_id }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(builder_lease.status(), StatusCode::OK);
    let builder_lease: serde_json::Value =
        serde_json::from_slice(&to_bytes(builder_lease.into_body(), usize::MAX).await?)?;
    let lease_id = builder_lease["leaseId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("lease response missing leaseId"))?;

    let viewer_read_token = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/access_token")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "protocol": "webdav",
                        "scopes": ["fs.read"],
                        "originId": origin_id
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(viewer_read_token.status(), StatusCode::OK);

    let viewer_write_token = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/access_token")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "protocol": "webdav",
                        "scopes": ["fs.write"],
                        "originId": origin_id,
                        "leaseId": lease_id
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(viewer_write_token.status(), StatusCode::FORBIDDEN);

    let builder_write_token = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/access_token")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {builder_token}"))
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "protocol": "webdav",
                        "scopes": ["fs.write"],
                        "originId": origin_id,
                        "leaseId": lease_id
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(builder_write_token.status(), StatusCode::OK);
    let builder_write_token: serde_json::Value =
        serde_json::from_slice(&to_bytes(builder_write_token.into_body(), usize::MAX).await?)?;
    let builder_origin_token = builder_write_token["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("builder origin response omitted token"))?;

    let live_builder_lease = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header("authorization", format!("Bearer {builder_origin_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(live_builder_lease.status(), StatusCode::OK);

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update org_memberships set role = 'viewer' where org_id = $1 and user_id = $2",
                &[&org_id, &builder_user_id],
            )
            .await?;
    }

    let downgraded_builder_lease = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header("authorization", format!("Bearer {builder_origin_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(downgraded_builder_lease.status(), StatusCode::FORBIDDEN);

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update org_memberships set role = 'builder' where org_id = $1 and user_id = $2",
                &[&org_id, &builder_user_id],
            )
            .await?;
    }

    for (path, body) in [
        (
            "/access_token".to_string(),
            json!({
                "projectId": project_id,
                "protocol": "webdav",
                "scopes": ["fs.read"],
                "originId": origin_id
            }),
        ),
        (
            format!("/projects/{project_id}/git/access_token"),
            json!({ "scopes": ["git.read"] }),
        ),
    ] {
        let exchange = origin_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {scoped_read_token}"))
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        assert_eq!(exchange.status(), StatusCode::FORBIDDEN);
    }

    for (caller, bearer) in [
        ("human", builder_token.as_str()),
        ("origin", scoped_read_token.as_str()),
        ("runtime", runtime_capability_token.as_str()),
    ] {
        let response = origin_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/projects/{project_id}/git/access_token"))
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {bearer}"))
                    .body(Body::from(
                        json!({ "scopes": ["git.delete"], "ttlSeconds": 600 }).to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{caller} minted git.delete"
        );
    }

    let mixed_delete_scope = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header("authorization", "Bearer internal")
                .body(Body::from(
                    json!({ "scopes": ["git.read", "git.delete"] }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(mixed_delete_scope.status(), StatusCode::BAD_REQUEST);

    let configured_service_role_delete_token = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header("authorization", "Bearer service-role-token")
                .body(Body::from(
                    json!({ "scopes": ["git.delete"], "ttlSeconds": 60 }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(
        configured_service_role_delete_token.status(),
        StatusCode::OK
    );

    let service_delete_token = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header("authorization", "Bearer internal")
                .body(Body::from(
                    json!({ "scopes": ["git.delete"], "ttlSeconds": 600 }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(service_delete_token.status(), StatusCode::OK);
    let service_delete_token: serde_json::Value =
        serde_json::from_slice(&to_bytes(service_delete_token.into_body(), usize::MAX).await?)?;
    assert_eq!(service_delete_token["scopes"], json!([GIT_DELETE_SCOPE]));
    assert_eq!(
        service_delete_token["expiresIn"],
        GIT_DELETE_TOKEN_TTL_SECONDS
    );
    let service_delete_claims = decode_scoped_token(
        &config,
        service_delete_token["token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("service git.delete response omitted token"))?,
        "service git delete token",
    )
    .map_err(|error| controller_error("decode service git.delete token", error))?;
    assert_eq!(service_delete_claims.aud, "git");
    assert_eq!(service_delete_claims.protocol.as_deref(), Some("git"));
    assert_eq!(service_delete_claims.scopes, vec![GIT_DELETE_SCOPE]);
    assert_eq!(
        service_delete_claims.exp - service_delete_claims.iat,
        GIT_DELETE_TOKEN_TTL_SECONDS
    );
    assert!(service_delete_claims.runtime_id.is_none());
    assert!(service_delete_claims.origin_id.is_none());
    assert!(service_delete_claims.lease_id.is_none());
    assert!(service_delete_claims.run_id.is_none());

    let runtime_git_write = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {runtime_capability_token}"),
                )
                .body(Body::from(
                    json!({ "scopes": ["git.read", "git.write"] }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(runtime_git_write.status(), StatusCode::FORBIDDEN);

    let runtime_git_read = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {runtime_capability_token}"),
                )
                .body(Body::from(json!({ "scopes": ["git.read"] }).to_string()))?,
        )
        .await?;
    assert_eq!(runtime_git_read.status(), StatusCode::OK);
    let runtime_git_read: serde_json::Value =
        serde_json::from_slice(&to_bytes(runtime_git_read.into_body(), usize::MAX).await?)?;
    let child_token = runtime_git_read["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("runtime git response omitted token"))?;
    let child_claims = decode_scoped_token(&config, child_token, "git token")
        .map_err(|error| controller_error("decode runtime git token", error))?;
    assert_eq!(
        child_claims.runtime_id.as_deref(),
        Some(&*runtime_id.to_string())
    );
    assert_eq!(
        child_claims.lease_id.as_deref(),
        Some(&*runtime_lease_id.to_string())
    );
    assert_eq!(child_claims.protocol.as_deref(), Some("git"));
    assert_eq!(child_claims.scopes, vec!["git.read"]);

    let legacy_runtime_git_read = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {legacy_runtime_token}"))
                .body(Body::from(json!({ "scopes": ["git.read"] }).to_string()))?,
        )
        .await?;
    assert_eq!(legacy_runtime_git_read.status(), StatusCode::OK);

    let mismatched_runtime_project = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{}/git/access_token", Uuid::new_v4()))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {runtime_capability_token}"),
                )
                .body(Body::from(json!({ "scopes": ["git.read"] }).to_string()))?,
        )
        .await?;
    assert_eq!(mismatched_runtime_project.status(), StatusCode::FORBIDDEN);

    let viewer_git_read = origin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::from(json!({ "scopes": ["git.read"] }).to_string()))?,
        )
        .await?;
    assert_eq!(viewer_git_read.status(), StatusCode::OK);

    let viewer_git_write = origin_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/git/access_token"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::from(json!({ "scopes": ["git.write"] }).to_string()))?,
        )
        .await?;
    assert_eq!(viewer_git_write.status(), StatusCode::FORBIDDEN);

    let runtime_app = crate::runtime::router().with_state(state);
    let viewer_runtime_token = runtime_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/runtime/token"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {viewer_token}"))
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(viewer_runtime_token.status(), StatusCode::FORBIDDEN);

    let builder_runtime_token = runtime_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/runtime/token"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {builder_token}"))
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(builder_runtime_token.status(), StatusCode::OK);
    let builder_runtime_token_body =
        to_bytes(builder_runtime_token.into_body(), usize::MAX).await?;
    let builder_runtime_token_body: serde_json::Value =
        serde_json::from_slice(&builder_runtime_token_body)?;
    let assigned_runtime_id = builder_runtime_token_body["runtimeId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("runtime token response omitted assigned runtimeId"))?;
    Uuid::parse_str(assigned_runtime_id)
        .map_err(|error| anyhow::anyhow!("assigned runtimeId is invalid: {error}"))?;

    let chosen_unused_runtime_id = Uuid::new_v4();
    let chosen_runtime_token = runtime_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/runtime/token"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {builder_token}"))
                .body(Body::from(
                    json!({ "runtimeId": chosen_unused_runtime_id }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(chosen_runtime_token.status(), StatusCode::FORBIDDEN);

    let scoped_runtime_token = runtime_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/runtime/token"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {scoped_read_token}"))
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(scoped_runtime_token.status(), StatusCode::FORBIDDEN);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &viewer_user_id).await?;
    cleanup_test_user(&pool, &builder_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn member_lists_fall_back_to_auth_user_metadata_for_display_name() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping member display name test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update auth.users
                 set raw_user_meta_data = $2::jsonb
                 where id = $1",
                &[&user_id, &PgJson(json!({ "full_name": "Android QA" }))],
            )
            .await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Member identity team')",
                &[&org_id, &format!("member-identity-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner')",
                &[&org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $2, $3, 'customer', 'active')",
                &[&project_id, &org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "member-display-name",
    );
    let user_token = crate::auth::issue_controller_token(&config, &user_id)
        .map_err(|error| controller_error("issue member display name token", error))?
        .token;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));

    let org_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/orgs/{org_id}/members?q=Android%20QA"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {user_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(org_response.status(), StatusCode::OK);
    let org_body = to_bytes(org_response.into_body(), usize::MAX).await?;
    let org_payload: serde_json::Value = serde_json::from_slice(&org_body)?;
    assert_eq!(org_payload["members"][0]["fullName"], "Android QA");

    let project_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/members"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {user_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(project_response.status(), StatusCode::OK);
    let project_body = to_bytes(project_response.into_body(), usize::MAX).await?;
    let project_payload: serde_json::Value = serde_json::from_slice(&project_body)?;
    assert_eq!(project_payload["members"][0]["fullName"], "Android QA");

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &user_id).await?;
    Ok(())
}

async fn ensure_conversation_event_test_tables(pool: &PgPool) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "alter table if exists conversations
                 add column if not exists visibility text not null default 'public',
                 add column if not exists parent_conversation_id uuid,
                 add column if not exists root_conversation_id uuid,
                 add column if not exists thread_kind text,
                 add column if not exists last_message_id uuid,
                 add column if not exists last_message_at timestamptz,
                 add column if not exists last_message_preview text;
             create table if not exists conversation_participants (
                 conversation_id uuid not null,
                 user_id uuid not null,
                 role text not null default 'member',
                 added_by uuid,
                 last_seen_message_id uuid,
                 last_seen_at timestamptz,
                 created_at timestamptz not null default now(),
                 primary key (conversation_id, user_id)
             );",
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn conversation_participants_include_scoped_display_names_without_email() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping conversation participant identity test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let guest_user_id = Uuid::new_v4();
    let added_user_id = Uuid::new_v4();
    let nonparticipant_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();

    for user_id in [
        owner_user_id,
        guest_user_id,
        added_user_id,
        nonparticipant_user_id,
    ] {
        ensure_test_user(&pool, &user_id).await?;
    }

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update auth.users
                 set raw_user_meta_data = case id
                   when $1 then $5::jsonb
                   when $2 then $6::jsonb
                   when $3 then $7::jsonb
                   when $4 then $8::jsonb
                   else raw_user_meta_data
                 end
                 where id = any($9)",
                &[
                    &owner_user_id,
                    &guest_user_id,
                    &added_user_id,
                    &nonparticipant_user_id,
                    &PgJson(json!({
                        "full_name": "Owner Metadata Name",
                        "email": "owner-metadata-secret@example.com"
                    })),
                    &PgJson(json!({
                        "name": "Guest Metadata Name",
                        "email": "guest-metadata-secret@example.com"
                    })),
                    &PgJson(json!({
                        "display_name": "Added Participant",
                        "email": "added-metadata-secret@example.com"
                    })),
                    &PgJson(json!({
                        "full_name": "Project Bystander",
                        "email": "bystander-metadata-secret@example.com"
                    })),
                    &vec![
                        owner_user_id,
                        guest_user_id,
                        added_user_id,
                        nonparticipant_user_id,
                    ],
                ],
            )
            .await?;
        connection
            .execute(
                "insert into profiles (user_id, full_name)
                 values ($1, 'Owner Profile Name')
                 on conflict (user_id) do update set full_name = excluded.full_name",
                &[&owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Participant identity test')",
                &[&org_id, &format!("participant-identity-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, project_type, owner_user_id, status)
                 values ($1, $2, 'Participant identity project', 'customer', $3, 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'viewer'), ($1, $3, 'viewer'), ($1, $4, 'viewer')",
                &[
                    &project_id,
                    &guest_user_id,
                    &added_user_id,
                    &nonparticipant_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'private')",
                &[&conversation_id, &project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'owner', null), ($1, $3, 'member', $2)",
                &[&conversation_id, &owner_user_id, &guest_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "conversation-participant-identity",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue participant owner token", error))?
        .token;
    let guest_token = crate::auth::issue_controller_token(&config, &guest_user_id)
        .map_err(|error| controller_error("issue participant guest token", error))?
        .token;
    let nonparticipant_token =
        crate::auth::issue_controller_token(&config, &nonparticipant_user_id)
            .map_err(|error| controller_error("issue participant nonparticipant token", error))?
            .token;
    let app = conversations::router().with_state(build_test_state(pool.clone(), config));

    let invalid_role_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/participants"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::from(
                    json!({ "userId": added_user_id, "role": "owner" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(invalid_role_response.status(), StatusCode::BAD_REQUEST);

    let add_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/participants"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::from(
                    json!({ "userId": added_user_id, "role": "member" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(add_response.status(), StatusCode::OK);
    let add_body = to_bytes(add_response.into_body(), usize::MAX).await?;
    let add_payload: serde_json::Value = serde_json::from_slice(&add_body)?;
    let add_participants = add_payload["participants"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("participant add response omitted participants"))?;
    assert_eq!(add_participants.len(), 3);
    assert_eq!(
        add_participants
            .iter()
            .find(|participant| participant["userId"] == owner_user_id.to_string())
            .and_then(|participant| participant["role"].as_str()),
        Some("owner")
    );
    assert_eq!(
        add_participants
            .iter()
            .find(|participant| participant["userId"] == added_user_id.to_string())
            .and_then(|participant| participant["role"].as_str()),
        Some("member")
    );
    assert_eq!(
        add_participants
            .iter()
            .find(|participant| participant["userId"] == owner_user_id.to_string())
            .and_then(|participant| participant["displayName"].as_str()),
        Some("Owner Profile Name")
    );
    assert_eq!(
        add_participants
            .iter()
            .find(|participant| participant["userId"] == guest_user_id.to_string())
            .and_then(|participant| participant["displayName"].as_str()),
        Some("Guest Metadata Name")
    );
    assert_eq!(
        add_participants
            .iter()
            .find(|participant| participant["userId"] == added_user_id.to_string())
            .and_then(|participant| participant["displayName"].as_str()),
        Some("Added Participant")
    );
    assert!(add_participants
        .iter()
        .all(|participant| participant.get("email").is_none()));
    assert!(!String::from_utf8_lossy(&add_body).contains("@example.com"));

    let guest_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/conversations/{conversation_id}/participants"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {guest_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(guest_response.status(), StatusCode::OK);
    let guest_body = to_bytes(guest_response.into_body(), usize::MAX).await?;
    let guest_payload: serde_json::Value = serde_json::from_slice(&guest_body)?;
    let guest_participants = guest_payload["participants"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("participant list response omitted participants"))?;
    assert_eq!(guest_participants.len(), 3);
    assert!(guest_participants.iter().any(|participant| {
        participant["userId"] == guest_user_id.to_string()
            && participant["displayName"] == "Guest Metadata Name"
    }));
    assert!(!guest_participants
        .iter()
        .any(|participant| participant["userId"] == nonparticipant_user_id.to_string()));
    assert!(!String::from_utf8_lossy(&guest_body).contains("Project Bystander"));
    assert!(guest_participants
        .iter()
        .all(|participant| participant.get("email").is_none()));
    assert!(!String::from_utf8_lossy(&guest_body).contains("@example.com"));

    let nonparticipant_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/conversations/{conversation_id}/participants"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {nonparticipant_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(nonparticipant_response.status(), StatusCode::FORBIDDEN);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    for user_id in [
        nonparticipant_user_id,
        added_user_id,
        guest_user_id,
        owner_user_id,
    ] {
        cleanup_test_user(&pool, &user_id).await?;
    }
    Ok(())
}

async fn ensure_conversation_invite_test_columns(pool: &PgPool) -> anyhow::Result<()> {
    ensure_conversation_event_test_tables(pool).await?;
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "alter table if exists org_invite_links
                 add column if not exists conversation_id uuid;
             alter table if exists org_invitations
                 add column if not exists conversation_id uuid;",
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn private_conversation_invite_link_requires_access_and_grants_participation(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private conversation invite test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_invite_test_columns(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let nonparticipant_user_id = Uuid::new_v4();
    let direct_viewer_user_id = Uuid::new_v4();
    let invitee_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &nonparticipant_user_id).await?;
    ensure_test_user(&pool, &direct_viewer_user_id).await?;
    ensure_test_user(&pool, &invitee_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("private-conversation-invite-{org_id}"),
                    &"Private conversation invite test",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'viewer'), ($1, $3, 'builder')",
                &[&org_id, &owner_user_id, &nonparticipant_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, project_type, owner_user_id, status)
                 values ($1, $2, 'Private invite project', 'customer', $3, 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'private')",
                &[&conversation_id, &project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'viewer')",
                &[&project_id, &direct_viewer_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "private-conversation-invite",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue owner token", error))?
        .token;
    let nonparticipant_token =
        crate::auth::issue_controller_token(&config, &nonparticipant_user_id)
            .map_err(|error| controller_error("issue nonparticipant token", error))?
            .token;
    let direct_viewer_token = crate::auth::issue_controller_token(&config, &direct_viewer_user_id)
        .map_err(|error| controller_error("issue direct viewer token", error))?
        .token;
    let invitee_token = crate::auth::issue_controller_token(&config, &invitee_user_id)
        .map_err(|error| controller_error("issue invitee token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = projects::router().with_state(state);
    let create_body = json!({
        "projectId": project_id,
        "conversationId": conversation_id,
        "role": "viewer"
    });

    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/invite-links"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {nonparticipant_token}"),
                )
                .body(Body::from(create_body.to_string()))?,
        )
        .await?;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let org_member_email = format!("controller-test+{nonparticipant_user_id}@example.com");
    let org_member_invitation = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/invitations"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::from(
                    json!({
                        "email": org_member_email,
                        "projectId": project_id,
                        "conversationId": conversation_id,
                        "role": "viewer"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(org_member_invitation.status(), StatusCode::OK);
    let org_member_invitation_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(org_member_invitation.into_body(), usize::MAX).await?)?;
    let org_member_invitation_id = org_member_invitation_payload["invitation"]["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invitation response omitted id"))?;
    let private_cancel_denied = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!(
                    "/orgs/{org_id}/invitations/{org_member_invitation_id}"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {nonparticipant_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(private_cancel_denied.status(), StatusCode::NOT_FOUND);
    let org_member_invite_token: Uuid = pool
        .get()
        .await?
        .query_one(
            "select token from org_invitations
             where org_id = $1 and project_id = $2 and conversation_id = $3
               and lower(email) = lower($4) and status = 'pending'",
            &[&org_id, &project_id, &conversation_id, &org_member_email],
        )
        .await?
        .get("token");
    let org_member_accept = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/org-invitations/accept")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {nonparticipant_token}"),
                )
                .body(Body::from(
                    json!({ "token": org_member_invite_token }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(org_member_accept.status(), StatusCode::OK);
    let org_member_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(org_member_accept.into_body(), usize::MAX).await?)?;
    assert_eq!(org_member_payload["role"], "builder");

    let direct_viewer_email = format!("controller-test+{direct_viewer_user_id}@example.com");
    let direct_viewer_invitation = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/invitations"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::from(
                    json!({
                        "email": direct_viewer_email,
                        "projectId": project_id,
                        "conversationId": conversation_id,
                        "role": "builder"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(direct_viewer_invitation.status(), StatusCode::OK);
    let direct_viewer_invite_token: Uuid = pool
        .get()
        .await?
        .query_one(
            "select token from org_invitations
             where org_id = $1 and project_id = $2 and conversation_id = $3
               and lower(email) = lower($4) and status = 'pending'",
            &[&org_id, &project_id, &conversation_id, &direct_viewer_email],
        )
        .await?
        .get("token");
    let direct_viewer_accept = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/org-invitations/accept")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {direct_viewer_token}"),
                )
                .body(Body::from(
                    json!({ "token": direct_viewer_invite_token }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(direct_viewer_accept.status(), StatusCode::OK);
    let direct_viewer_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(direct_viewer_accept.into_body(), usize::MAX).await?)?;
    assert_eq!(direct_viewer_payload["role"], "builder");

    {
        let connection = pool.get().await?;
        let org_member_direct_memberships: i64 = connection
            .query_one(
                "select count(*) from project_memberships where project_id = $1 and user_id = $2",
                &[&project_id, &nonparticipant_user_id],
            )
            .await?
            .get(0);
        let direct_viewer_role: String = connection
            .query_one(
                "select role from project_memberships where project_id = $1 and user_id = $2",
                &[&project_id, &direct_viewer_user_id],
            )
            .await?
            .get("role");
        let invited_existing_participants: i64 = connection
            .query_one(
                "select count(*) from conversation_participants
                 where conversation_id = $1 and user_id in ($2, $3)",
                &[
                    &conversation_id,
                    &nonparticipant_user_id,
                    &direct_viewer_user_id,
                ],
            )
            .await?
            .get(0);
        assert_eq!(org_member_direct_memberships, 0);
        assert_eq!(direct_viewer_role, "builder");
        assert_eq!(invited_existing_participants, 2);
    }

    let created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/invite-links"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::from(create_body.to_string()))?,
        )
        .await?;
    assert_eq!(created.status(), StatusCode::OK);
    let created_body = to_bytes(created.into_body(), usize::MAX).await?;
    let created_json: serde_json::Value = serde_json::from_slice(&created_body)?;
    assert_eq!(
        created_json["inviteLink"]["conversationId"],
        json!(conversation_id)
    );
    let token = created_json["inviteLink"]["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invite response omitted token"))?;

    let accepted = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/org-invitations/accept")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {invitee_token}"),
                )
                .body(Body::from(json!({ "token": token }).to_string()))?,
        )
        .await?;
    assert_eq!(accepted.status(), StatusCode::OK);
    let accepted_body = to_bytes(accepted.into_body(), usize::MAX).await?;
    let accepted_json: serde_json::Value = serde_json::from_slice(&accepted_body)?;
    assert_eq!(accepted_json["projectId"], json!(project_id));
    assert_eq!(accepted_json["conversationId"], json!(conversation_id));

    {
        let connection = pool.get().await?;
        let project_membership = connection
            .query_one(
                "select count(*) from project_memberships where project_id = $1 and user_id = $2",
                &[&project_id, &invitee_user_id],
            )
            .await?
            .get::<_, i64>(0);
        let conversation_participation = connection
            .query_one(
                "select count(*) from conversation_participants where conversation_id = $1 and user_id = $2",
                &[&conversation_id, &invitee_user_id],
            )
            .await?
            .get::<_, i64>(0);
        let org_membership = connection
            .query_one(
                "select count(*) from org_memberships where org_id = $1 and user_id = $2",
                &[&org_id, &invitee_user_id],
            )
            .await?
            .get::<_, i64>(0);
        assert_eq!(project_membership, 1);
        assert_eq!(conversation_participation, 1);
        assert_eq!(org_membership, 0);
    }

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &invitee_user_id).await?;
    cleanup_test_user(&pool, &direct_viewer_user_id).await?;
    cleanup_test_user(&pool, &nonparticipant_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn invite_acceptance_preserves_roles_and_project_builders_cancel_project_invites(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping invite role preservation test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_invite_test_columns(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let direct_builder_user_id = Uuid::new_v4();
    let org_builder_user_id = Uuid::new_v4();
    let org_viewer_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let org_link_token = Uuid::new_v4();
    let org_upgrade_link_token = Uuid::new_v4();
    let project_link_token = Uuid::new_v4();
    let project_invitation_id = Uuid::new_v4();
    let org_invitation_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &direct_builder_user_id).await?;
    ensure_test_user(&pool, &org_builder_user_id).await?;
    ensure_test_user(&pool, &org_viewer_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("invite-role-preservation-{org_id}"),
                    &"Invite role preservation",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder'), ($1, $4, 'viewer')",
                &[
                    &org_id,
                    &owner_user_id,
                    &org_builder_user_id,
                    &org_viewer_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Shared project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &direct_builder_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into org_invite_links
                    (org_id, project_id, role, token, created_by, status, expires_at)
                 values ($1, null, 'viewer', $2, $3, 'active', now() + interval '1 day'),
                        ($1, $4, 'viewer', $5, $3, 'active', now() + interval '1 day'),
                        ($1, null, 'builder', $6, $3, 'active', now() + interval '1 day')",
                &[
                    &org_id,
                    &org_link_token,
                    &owner_user_id,
                    &project_id,
                    &project_link_token,
                    &org_upgrade_link_token,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_invitations
                    (id, org_id, project_id, email, role, token, invited_by, status, expires_at)
                 values ($1, $2, $3, $4, 'viewer', $5, $6, 'pending', now() + interval '1 day'),
                        ($7, $2, null, $8, 'viewer', $9, $6, 'pending', now() + interval '1 day')",
                &[
                    &project_invitation_id,
                    &org_id,
                    &project_id,
                    &format!("project-invite-{project_invitation_id}@example.com"),
                    &Uuid::new_v4(),
                    &owner_user_id,
                    &org_invitation_id,
                    &format!("org-invite-{org_invitation_id}@example.com"),
                    &Uuid::new_v4(),
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "invite-role-preservation",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue owner token", error))?
        .token;
    let direct_builder_token =
        crate::auth::issue_controller_token(&config, &direct_builder_user_id)
            .map_err(|error| controller_error("issue direct builder token", error))?
            .token;
    let org_builder_token = crate::auth::issue_controller_token(&config, &org_builder_user_id)
        .map_err(|error| controller_error("issue org builder token", error))?
        .token;
    let org_viewer_token = crate::auth::issue_controller_token(&config, &org_viewer_user_id)
        .map_err(|error| controller_error("issue org viewer token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let mut access_events = state.events.subscribe();
    let app = projects::router().with_state(state);

    for (token, bearer, expected_role, target_user_id, event_project_id) in [
        (
            org_link_token,
            owner_token.as_str(),
            "owner",
            owner_user_id,
            None,
        ),
        (
            project_link_token,
            owner_token.as_str(),
            "owner",
            owner_user_id,
            Some(project_id),
        ),
        (
            project_link_token,
            direct_builder_token.as_str(),
            "builder",
            direct_builder_user_id,
            Some(project_id),
        ),
        (
            org_upgrade_link_token,
            org_viewer_token.as_str(),
            "builder",
            org_viewer_user_id,
            None,
        ),
    ] {
        let accepted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/org-invitations/accept")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {bearer}"))
                    .body(Body::from(json!({ "token": token }).to_string()))?,
            )
            .await?;
        assert_eq!(accepted.status(), StatusCode::OK);
        let payload: serde_json::Value =
            serde_json::from_slice(&to_bytes(accepted.into_body(), usize::MAX).await?)?;
        assert_eq!(payload["role"], expected_role);

        let event = timeout(std::time::Duration::from_secs(2), access_events.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timed out waiting for invite access invalidation"))??;
        assert_eq!(event.kind, "project.access_changed");
        assert_eq!(event.project_id, event_project_id);
        assert_eq!(event.target_user_id, Some(target_user_id));
        assert_eq!(event.data, json!({ "reason": "membership_changed" }));
    }

    {
        let connection = pool.get().await?;
        let owner_role: String = connection
            .query_one(
                "select role from org_memberships where org_id = $1 and user_id = $2",
                &[&org_id, &owner_user_id],
            )
            .await?
            .get("role");
        let owner_project_membership_count: i64 = connection
            .query_one(
                "select count(*) from project_memberships where project_id = $1 and user_id = $2",
                &[&project_id, &owner_user_id],
            )
            .await?
            .get(0);
        let direct_builder_role: String = connection
            .query_one(
                "select role from project_memberships where project_id = $1 and user_id = $2",
                &[&project_id, &direct_builder_user_id],
            )
            .await?
            .get("role");
        let upgraded_org_viewer_role: String = connection
            .query_one(
                "select role from org_memberships where org_id = $1 and user_id = $2",
                &[&org_id, &org_viewer_user_id],
            )
            .await?
            .get("role");
        assert_eq!(owner_role, "owner");
        assert_eq!(owner_project_membership_count, 0);
        assert_eq!(direct_builder_role, "builder");
        assert_eq!(upgraded_org_viewer_role, "builder");
    }

    let expired_link_token = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update org_invite_links set status = 'revoked' where token = $1",
                &[&org_link_token],
            )
            .await?;
        connection
            .execute(
                "insert into org_invite_links
                    (org_id, project_id, role, token, created_by, status, expires_at)
                 values ($1, null, 'viewer', $2, $3, 'active', now() - interval '1 day')",
                &[&org_id, &expired_link_token, &owner_user_id],
            )
            .await?;
    }
    let expired_accept = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/org-invitations/accept")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::from(
                    json!({ "token": expired_link_token }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(expired_accept.status(), StatusCode::BAD_REQUEST);
    let expired_status: String = pool
        .get()
        .await?
        .query_one(
            "select status from org_invite_links where token = $1",
            &[&expired_link_token],
        )
        .await?
        .get("status");
    assert_eq!(expired_status, "expired");

    let canceled_project = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!(
                    "/orgs/{org_id}/invitations/{project_invitation_id}"
                ))
                .header("authorization", format!("Bearer {org_builder_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(canceled_project.status(), StatusCode::NO_CONTENT);

    let denied_org_cancel = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/orgs/{org_id}/invitations/{org_invitation_id}"))
                .header("authorization", format!("Bearer {org_builder_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_org_cancel.status(), StatusCode::FORBIDDEN);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &org_viewer_user_id).await?;
    cleanup_test_user(&pool, &org_builder_user_id).await?;
    cleanup_test_user(&pool, &direct_builder_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn concurrent_email_invitations_are_idempotent_and_never_replace_roles() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping concurrent email invitation test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_invite_test_columns(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let stable_email = format!("Stable.Invite+{org_id}@Example.COM");
    let conflicting_email = format!("conflicting-invite+{org_id}@example.com");
    ensure_test_user(&pool, &owner_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("concurrent-email-invite-{org_id}"),
                    &"Concurrent email invitation",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&org_id, &owner_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "concurrent-email-invitation",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue concurrent invitation owner token", error))?
        .token;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));

    const CONCURRENT_REQUESTS: usize = 6;
    let start = Arc::new(tokio::sync::Barrier::new(CONCURRENT_REQUESTS));
    let responses = futures_util::future::join_all((0..CONCURRENT_REQUESTS).map(|index| {
        let app = app.clone();
        let owner_token = owner_token.clone();
        let start = start.clone();
        let email = if index % 2 == 0 {
            stable_email.clone()
        } else {
            stable_email.to_ascii_lowercase()
        };
        async move {
            start.wait().await;
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/orgs/{org_id}/invitations"))
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {owner_token}"))
                    .body(Body::from(
                        json!({ "email": email, "role": "builder" }).to_string(),
                    ))
                    .expect("build concurrent email invitation request"),
            )
            .await
        }
    }))
    .await;

    let mut invitation_ids = std::collections::HashSet::new();
    let mut accept_urls = std::collections::HashSet::new();
    for response in responses {
        let response = response?;
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "idempotent invitation response: {}",
            String::from_utf8_lossy(&body)
        );
        let payload: serde_json::Value = serde_json::from_slice(&body)?;
        invitation_ids.insert(
            payload["invitation"]["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invitation response omitted id"))?
                .to_string(),
        );
        accept_urls.insert(
            payload["acceptUrl"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invitation response omitted acceptUrl"))?
                .to_string(),
        );
        assert_eq!(payload["invitation"]["role"], "builder");
    }
    assert_eq!(invitation_ids.len(), 1);
    assert_eq!(accept_urls.len(), 1);

    let start = Arc::new(tokio::sync::Barrier::new(2));
    let conflicting_responses =
        futures_util::future::join_all(["viewer", "builder"].into_iter().map(|role| {
            let app = app.clone();
            let owner_token = owner_token.clone();
            let start = start.clone();
            let email = conflicting_email.clone();
            async move {
                start.wait().await;
                app.oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/orgs/{org_id}/invitations"))
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {owner_token}"))
                        .body(Body::from(
                            json!({ "email": email, "role": role }).to_string(),
                        ))
                        .expect("build conflicting email invitation request"),
                )
                .await
            }
        }))
        .await;

    let mut created_role = None;
    let mut conflict_count = 0;
    for response in conflicting_responses {
        let response = response?;
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        let payload: serde_json::Value = serde_json::from_slice(&body)?;
        match status {
            StatusCode::OK => {
                created_role = Some(
                    payload["invitation"]["role"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("created invitation omitted role"))?
                        .to_string(),
                );
            }
            StatusCode::CONFLICT => {
                conflict_count += 1;
                assert_eq!(payload["code"], "invitation_role_conflict");
            }
            _ => anyhow::bail!(
                "unexpected conflicting invitation response {status}: {}",
                String::from_utf8_lossy(&body)
            ),
        }
    }
    assert_eq!(conflict_count, 1);
    let created_role = created_role
        .ok_or_else(|| anyhow::anyhow!("one conflicting invitation should have been created"))?;

    let connection = pool.get().await?;
    let stable_counts = connection
        .query_one(
            "select count(*) as invitations,
                    (select count(*) from email_outbox where lower(to_email) = lower($2)) as emails
             from org_invitations
             where org_id = $1 and project_id is null
               and lower(email) = lower($2) and status = 'pending'",
            &[&org_id, &stable_email],
        )
        .await?;
    assert_eq!(stable_counts.get::<_, i64>("invitations"), 1);
    assert_eq!(stable_counts.get::<_, i64>("emails"), 1);

    let conflicting_row = connection
        .query_one(
            "select count(*) as invitations, min(role) as role,
                    (select count(*) from email_outbox where lower(to_email) = lower($2)) as emails
             from org_invitations
             where org_id = $1 and project_id is null
               and lower(email) = lower($2) and status = 'pending'",
            &[&org_id, &conflicting_email],
        )
        .await?;
    assert_eq!(conflicting_row.get::<_, i64>("invitations"), 1);
    assert_eq!(
        conflicting_row.get::<_, Option<String>>("role"),
        Some(created_role)
    );
    assert_eq!(conflicting_row.get::<_, i64>("emails"), 1);
    connection
        .execute(
            "delete from email_outbox
             where lower(to_email) = lower($1) or lower(to_email) = lower($2)",
            &[&stable_email, &conflicting_email],
        )
        .await?;
    drop(connection);

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn concurrent_invite_link_rotation_leaves_one_active_link_per_scope() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping concurrent invite link rotation test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_invite_test_columns(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("concurrent-invite-link-{org_id}"),
                    &"Concurrent invite link rotation",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Concurrent invite project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "concurrent-invite-link-rotation",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue invite rotation owner token", error))?
        .token;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));

    const CONCURRENT_REQUESTS: usize = 6;
    let start = Arc::new(tokio::sync::Barrier::new(CONCURRENT_REQUESTS));
    let responses = futures_util::future::join_all((0..CONCURRENT_REQUESTS).map(|_| {
        let app = app.clone();
        let owner_token = owner_token.clone();
        let start = start.clone();
        async move {
            start.wait().await;
            let request = Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/invite-links"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::from(
                    json!({ "projectId": project_id, "role": "builder" }).to_string(),
                ))
                .expect("build concurrent invite rotation request");
            app.oneshot(request).await
        }
    }))
    .await;

    let mut returned_ids = std::collections::HashSet::new();
    for response in responses {
        let response = response?;
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "invite rotation response: {}",
            String::from_utf8_lossy(&body)
        );
        let payload: serde_json::Value = serde_json::from_slice(&body)?;
        returned_ids.insert(Uuid::parse_str(
            payload["inviteLink"]["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invite response omitted id"))?,
        )?);
    }
    assert_eq!(returned_ids.len(), CONCURRENT_REQUESTS);

    let connection = pool.get().await?;
    let counts = connection
        .query_one(
            "select count(*) as total,
                    count(*) filter (where status = 'active') as active,
                    count(*) filter (where status = 'revoked') as revoked,
                    count(*) filter (where status = 'revoked' and revoked_by = $3) as attributed
             from org_invite_links
             where org_id = $1
               and project_id = $2
               and conversation_id is null",
            &[&org_id, &project_id, &owner_user_id],
        )
        .await?;
    assert_eq!(counts.get::<_, i64>("total"), CONCURRENT_REQUESTS as i64);
    assert_eq!(counts.get::<_, i64>("active"), 1);
    assert_eq!(
        counts.get::<_, i64>("revoked"),
        (CONCURRENT_REQUESTS - 1) as i64
    );
    assert_eq!(
        counts.get::<_, i64>("attributed"),
        (CONCURRENT_REQUESTS - 1) as i64
    );
    drop(connection);

    let org_link = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/orgs/{org_id}/invite-links"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::from(json!({ "role": "viewer" }).to_string()))?,
        )
        .await?;
    assert_eq!(org_link.status(), StatusCode::OK);
    let org_link_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(org_link.into_body(), usize::MAX).await?)?;
    let org_link_id = org_link_payload["inviteLink"]["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("org invite link response omitted id"))?;

    let org_links = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/orgs/{org_id}/invite-links"))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(org_links.status(), StatusCode::OK);
    let org_links_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(org_links.into_body(), usize::MAX).await?)?;
    let listed_org_links = org_links_payload["inviteLinks"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("org invite link list omitted inviteLinks"))?;
    assert_eq!(listed_org_links.len(), 1);
    assert_eq!(listed_org_links[0]["id"], org_link_id);
    assert_eq!(listed_org_links[0]["projectId"], serde_json::Value::Null);
    assert_eq!(
        listed_org_links[0]["conversationId"],
        serde_json::Value::Null
    );

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn controller_auth_is_header_only_and_event_stream_reauthorizes_private_conversations_per_event(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping conversation event access test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let project_member_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let private_conversation_id = Uuid::new_v4();
    let public_conversation_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &project_member_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("conversation-event-access-{org_id}"),
                    &"Conversation event access test",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, project_type, owner_user_id, status)
                 values ($1, $2, 'customer', $3, 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &project_member_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'private'),
                        ($4, $2, $3, '{}'::jsonb, 'public')",
                &[
                    &private_conversation_id,
                    &project_id,
                    &owner_user_id,
                    &public_conversation_id,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "conversation-event-access",
    );
    let project_member_token =
        crate::auth::issue_controller_token(&config, &project_member_user_id)
            .map_err(|error| controller_error("issue project member token", error))?
            .token;
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue owner token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = crate::events::router().with_state(state.clone());

    let denied_query_only = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/events?projectId={project_id}&conversationId={private_conversation_id}&accessToken={owner_token}"
                ))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_query_only.status(), StatusCode::UNAUTHORIZED);

    let denied_query_override = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/events?projectId={project_id}&conversationId={private_conversation_id}&accessToken={owner_token}"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {project_member_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_query_override.status(), StatusCode::FORBIDDEN);

    let workspace_app = crate::workspace::router().with_state(state.clone());
    let workspace_body = json!({
        "path": "workspace",
        "deviceId": "header-only-auth-test",
        "accessToken": owner_token,
    });
    let denied_body_only = workspace_app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/projects/{project_id}/workspaces/local"))
                .header("content-type", "application/json")
                .body(Body::from(workspace_body.to_string()))?,
        )
        .await?;
    assert_eq!(denied_body_only.status(), StatusCode::UNAUTHORIZED);

    let allowed_header_over_body = workspace_app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/projects/{project_id}/workspaces/local"))
                .header("content-type", "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {project_member_token}"),
                )
                .body(Body::from(workspace_body.to_string()))?,
        )
        .await?;
    assert_eq!(allowed_header_over_body.status(), StatusCode::OK);
    assert!(state
        .local_workspaces
        .get_active(
            &project_id,
            &project_member_user_id,
            crate::workspace::local_workspace_ttl(),
        )
        .await
        .is_some());
    assert!(state
        .local_workspaces
        .get_active(
            &project_id,
            &owner_user_id,
            crate::workspace::local_workspace_ttl(),
        )
        .await
        .is_none());

    let denied_explicit = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/events?projectId={project_id}&conversationId={private_conversation_id}"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {project_member_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_explicit.status(), StatusCode::FORBIDDEN);

    let allowed_owner = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/events?projectId={project_id}&conversationId={private_conversation_id}"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(allowed_owner.status(), StatusCode::OK);
    drop(allowed_owner);

    let allowed_service_role = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/events?projectId={project_id}&conversationId={private_conversation_id}"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(allowed_service_role.status(), StatusCode::OK);
    drop(allowed_service_role);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/events?projectId={project_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {project_member_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let mut event_body = response.into_body().into_data_stream();

    publish_controller_event_with_conversation(
        &state.events,
        "conversation.message_created",
        Some(project_id),
        None,
        Some(private_conversation_id),
        None,
        None,
        json!({ "marker": "private-before-participant" }),
    );
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.message_created",
        Some(project_id),
        None,
        Some(public_conversation_id),
        None,
        None,
        json!({ "marker": "public-before-participant" }),
    );
    let before_participant = timeout(std::time::Duration::from_secs(3), event_body.next())
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for public conversation event"))?
        .ok_or_else(|| anyhow::anyhow!("conversation event stream ended unexpectedly"))??;
    let before_participant = std::str::from_utf8(&before_participant)?;
    assert!(before_participant.contains("public-before-participant"));
    assert!(!before_participant.contains("private-before-participant"));

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'member', $3)",
                &[
                    &private_conversation_id,
                    &project_member_user_id,
                    &owner_user_id,
                ],
            )
            .await?;
    }
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.message_created",
        Some(project_id),
        None,
        Some(private_conversation_id),
        None,
        None,
        json!({ "marker": "private-while-participant" }),
    );
    let while_participant = timeout(std::time::Duration::from_secs(3), event_body.next())
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for authorized private event"))?
        .ok_or_else(|| anyhow::anyhow!("conversation event stream ended unexpectedly"))??;
    let while_participant = std::str::from_utf8(&while_participant)?;
    assert!(while_participant.contains("private-while-participant"));

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from conversation_participants
                 where conversation_id = $1 and user_id = $2",
                &[&private_conversation_id, &project_member_user_id],
            )
            .await?;
    }
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.message_created",
        Some(project_id),
        None,
        Some(private_conversation_id),
        None,
        None,
        json!({ "marker": "private-after-removal" }),
    );
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.message_created",
        Some(project_id),
        None,
        Some(public_conversation_id),
        None,
        None,
        json!({ "marker": "public-after-removal" }),
    );
    let after_removal = timeout(std::time::Duration::from_secs(3), event_body.next())
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for public event after removal"))?
        .ok_or_else(|| anyhow::anyhow!("conversation event stream ended unexpectedly"))??;
    let after_removal = std::str::from_utf8(&after_removal)?;
    assert!(after_removal.contains("public-after-removal"));
    assert!(!after_removal.contains("private-after-removal"));

    // Revoking project access must also take effect for an already-open stream.
    // Public-conversation and project-wide events would otherwise bypass the
    // private participant check above.
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&project_id, &project_member_user_id],
            )
            .await?;
    }
    assert!(crate::events::ensure_event_access(
        &state,
        project_id,
        None,
        Some(public_conversation_id),
        &RequestContext {
            user_id: Some(project_member_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
    )
    .await
    .is_err());
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.message_created",
        Some(project_id),
        None,
        Some(public_conversation_id),
        None,
        None,
        json!({ "marker": "public-after-project-revocation" }),
    );
    publish_controller_event(
        &state.events,
        "project.changed",
        Some(project_id),
        None,
        None,
        None,
        json!({ "marker": "project-wide-after-project-revocation" }),
    );

    // Keep polling while access is revoked so the lazy response stream
    // actually reauthorizes and suppresses both queued events before the
    // positive control restores membership. Sleeping without polling leaves
    // the events queued until the next `event_body.next()`, at which point a
    // restored membership would authorize stale events from the revoked
    // interval.
    match timeout(std::time::Duration::from_secs(1), event_body.next()).await {
        Err(_) => {}
        Ok(Some(Ok(chunk))) => {
            return Err(anyhow::anyhow!(
                "revoked project member received a controller event: {}",
                std::str::from_utf8(&chunk)?
            ));
        }
        Ok(Some(Err(error))) => return Err(error.into()),
        Ok(None) => {
            return Err(anyhow::anyhow!(
                "conversation event stream ended unexpectedly"
            ));
        }
    }

    // A targeted capability invalidation is the one safe exception: it carries
    // no project content and lets the revoked user's already-open clients
    // immediately refetch/fail closed. Ordinary project and conversation
    // events above remain suppressed.
    crate::state::publish_project_access_changed(
        &state.events,
        Some(project_id),
        project_member_user_id,
    );
    let access_changed = timeout(std::time::Duration::from_secs(3), event_body.next())
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for targeted access invalidation"))?
        .ok_or_else(|| anyhow::anyhow!("conversation event stream ended unexpectedly"))??;
    let access_changed = std::str::from_utf8(&access_changed)?;
    assert!(access_changed.contains("project.access_changed"));
    assert!(access_changed.contains("membership_changed"));
    assert!(!access_changed.contains("public-after-project-revocation"));
    assert!(!access_changed.contains("project-wide-after-project-revocation"));

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &project_member_user_id],
            )
            .await?;
    }
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.message_created",
        Some(project_id),
        None,
        Some(public_conversation_id),
        None,
        None,
        json!({ "marker": "public-after-project-access-restored" }),
    );
    timeout(std::time::Duration::from_secs(3), async {
        loop {
            let chunk = event_body
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("conversation event stream ended unexpectedly"))??;
            let chunk = std::str::from_utf8(&chunk)?;
            if chunk.contains("after-project-revocation") {
                return Err(anyhow::anyhow!(
                    "revoked project member received a controller event: {chunk}"
                ));
            }
            if chunk.contains("public-after-project-access-restored") {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for event after restoring project access"))??;
    drop(event_body);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &project_member_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn event_stream_hides_private_runtime_lifecycle_from_project_teammates() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private runtime event visibility test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let private_runtime_id = Uuid::new_v4();
    let managed_runtime_id = Uuid::new_v4();
    let runtime_lease_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let hosted_origin_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("instafy:hosted-origin:{project_id}").as_bytes(),
    );
    let spoofed_hosted_origin_id = Uuid::new_v4();
    let hosted_origin_endpoint = "https://configured-origin.invalid";
    let origin_instance_id = Uuid::new_v4();
    let tunnel_grant_id = Uuid::new_v4();
    let tunnel_id = format!("private-event-{tunnel_grant_id}");

    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &teammate_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("private-runtime-events-{org_id}"),
                    &"Private runtime event visibility test",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, project_type, owner_user_id, status)
                 values ($1, $2, 'customer', $3, 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &teammate_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, endpoint_url, capabilities)
                 values ($1, $3, 'self-hosted', 'ready', 'http://private-runtime.invalid', $5),
                        ($2, $3, 'instafy-cloud', 'ready', 'http://managed-runtime.invalid', $4)",
                &[
                    &private_runtime_id,
                    &managed_runtime_id,
                    &project_id,
                    &PgJson(json!({})),
                    &PgJson(json!({
                        "_instafySelfHostedAccess": {
                            "mode": "private",
                            "ownerUserId": owner_user_id.to_string(),
                        }
                    })),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (id, project_id, runtime_id, status)
                 values ($1, $2, $3, 'active')",
                &[&runtime_lease_id, &project_id, &private_runtime_id],
            )
            .await?;
        connection
            .execute(
                "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                 values ($1, $2, 'desktop', 'http://private-origin.invalid', array['http']),
                        ($3, $2, 'hosted', $5, array['http']),
                        ($4, $2, 'hosted', $5, array['http'])",
                &[
                    &origin_id,
                    &project_id,
                    &hosted_origin_id,
                    &spoofed_hosted_origin_id,
                    &hosted_origin_endpoint,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into origin_instances
                   (id, project_id, runtime_id, lease_id, origin_id, mode, status, endpoint, protocols)
                 values ($1, $2, $3, $4, $5, 'desktop', 'online',
                         'http://private-origin.invalid', array['http'])",
                &[
                    &origin_instance_id,
                    &project_id,
                    &private_runtime_id,
                    &runtime_lease_id,
                    &origin_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_tunnel_grants
                   (id, project_id, runtime_id, runtime_lease_id, provider, tunnel_id,
                    hostname, url, status, expires_at)
                 values ($1, $2, null, $3, 'self_hosted', $4,
                         'private-tunnel.invalid', 'https://private-tunnel.invalid',
                         'active', $5)",
                &[
                    &tunnel_grant_id,
                    &project_id,
                    &runtime_lease_id,
                    &tunnel_id,
                    &(Utc::now() + ChronoDuration::hours(1)),
                ],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "private-runtime-event-visibility",
    );
    config.hosted_origin_endpoint = Some(hosted_origin_endpoint.to_string());
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue owner token", error))?
        .token;
    let teammate_token = crate::auth::issue_controller_token(&config, &teammate_user_id)
        .map_err(|error| controller_error("issue teammate token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = crate::events::router().with_state(state.clone());

    let teammate_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/events?projectId={project_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {teammate_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(teammate_response.status(), StatusCode::OK);
    let mut teammate_events = teammate_response.into_body().into_data_stream();

    let owner_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/events?projectId={project_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(owner_response.status(), StatusCode::OK);
    let mut owner_events = owner_response.into_body().into_data_stream();

    for (kind, data) in [
        (
            "runtime.login",
            json!({ "runtimeId": private_runtime_id, "marker": "private-runtime" }),
        ),
        (
            "runtime.preference_updated",
            json!({ "runtimeId": private_runtime_id, "marker": "private-preference" }),
        ),
        (
            "origin.heartbeat",
            json!({ "originId": origin_id, "marker": "private-origin" }),
        ),
        (
            "workspace.commit",
            json!({ "originId": origin_id, "marker": "private-commit" }),
        ),
        (
            "tunnel.status_updated",
            json!({
                "runtimeLeaseId": runtime_lease_id,
                "tunnelId": tunnel_id,
                "marker": "private-tunnel",
            }),
        ),
    ] {
        publish_controller_event(
            &state.events,
            kind,
            Some(project_id),
            None,
            None,
            None,
            data,
        );
    }
    crate::state::publish_controller_event_to_user(
        &state.events,
        "local_workspace.heartbeat",
        Some(project_id),
        owner_user_id,
        json!({
            "runtimeId": private_runtime_id,
            "marker": "private-local-workspace",
        }),
    );
    publish_controller_event(
        &state.events,
        "telemetry.system_issue.created",
        Some(project_id),
        None,
        None,
        None,
        json!({
            "runtimeId": private_runtime_id,
            "marker": "private-telemetry",
        }),
    );
    publish_controller_event(
        &state.events,
        "tunnel.status_updated",
        Some(project_id),
        None,
        None,
        None,
        json!({
            "id": Uuid::new_v4(),
            "runtimeId": managed_runtime_id,
            "tunnelId": "forged-unbound-tunnel",
            "marker": "forged-tunnel-reference",
        }),
    );
    publish_controller_event(
        &state.events,
        "origin.heartbeat",
        Some(project_id),
        None,
        None,
        None,
        json!({
            "originId": spoofed_hosted_origin_id,
            "marker": "unbound-spoofed-hosted-origin",
        }),
    );
    publish_controller_event(
        &state.events,
        "origin.heartbeat",
        Some(project_id),
        None,
        None,
        None,
        json!({
            "originId": hosted_origin_id,
            "marker": "configured-hosted-origin",
        }),
    );
    publish_controller_event(
        &state.events,
        "runtime.login",
        Some(project_id),
        None,
        None,
        None,
        json!({ "runtimeId": managed_runtime_id, "marker": "managed-positive-control" }),
    );

    let teammate_payload = timeout(std::time::Duration::from_secs(10), async {
        let mut payload = String::new();
        for _ in 0..2 {
            let chunk = teammate_events
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("teammate event stream ended unexpectedly"))??;
            payload.push_str(std::str::from_utf8(&chunk)?);
        }
        Ok::<_, anyhow::Error>(payload)
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for shared runtime events"))??;
    assert!(teammate_payload.contains("configured-hosted-origin"));
    assert!(teammate_payload.contains("managed-positive-control"));
    assert!(!teammate_payload.contains("private-"));
    assert!(!teammate_payload.contains("forged-tunnel-reference"));
    assert!(!teammate_payload.contains("unbound-spoofed-hosted-origin"));

    let owner_payload = timeout(std::time::Duration::from_secs(10), async {
        let mut payload = String::new();
        for _ in 0..9 {
            let chunk = owner_events
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("owner event stream ended unexpectedly"))??;
            payload.push_str(std::str::from_utf8(&chunk)?);
        }
        Ok::<_, anyhow::Error>(payload)
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for owner runtime events"))??;
    for marker in [
        "private-runtime",
        "private-preference",
        "private-origin",
        "private-commit",
        "private-tunnel",
        "private-local-workspace",
        "private-telemetry",
        "configured-hosted-origin",
        "managed-positive-control",
    ] {
        assert!(
            owner_payload.contains(marker),
            "missing owner marker {marker}"
        );
    }
    assert!(!owner_payload.contains("forged-tunnel-reference"));
    assert!(!owner_payload.contains("unbound-spoofed-hosted-origin"));

    drop(owner_events);
    drop(teammate_events);
    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &teammate_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn notification_inbox_and_push_recipients_require_current_project_access(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping notification revocation test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let revoked_user_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let message_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &revoked_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, name, project_type, owner_user_id, status)
                 values ($1, 'Private notification test', 'customer', $2, 'active')",
                &[&project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &revoked_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (
                     id, project_id, created_by, metadata, visibility, last_message_id,
                     last_message_at, last_message_preview
                 ) values (
                     $1, $2, $3, '{\"title\":\"Private test\"}'::jsonb, 'private',
                     $4, now(), 'private notification contents'
                 )",
                &[&conversation_id, &project_id, &owner_user_id, &message_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'member', $3)",
                &[&conversation_id, &revoked_user_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, role, content, metadata, created_by
                 ) values (
                     $1, $2, $3, 'assistant', 'private notification contents', '{}'::jsonb, $4
                 )",
                &[&message_id, &conversation_id, &project_id, &owner_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "notification-revocation",
    );
    let revoked_user_token = crate::auth::issue_controller_token(&config, &revoked_user_id)
        .map_err(|error| controller_error("issue notification test token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = crate::notifications::router().with_state(state);

    let recipients_before = {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let conversation =
            crate::conversations::load_conversation_record(&transaction, &conversation_id)
                .await
                .map_err(|error| {
                    controller_error("load notification conversation before revocation", error)
                })?;
        let recipients = crate::notifications::load_notification_recipients(
            &transaction,
            &conversation,
            Some(owner_user_id),
        )
        .await?;
        transaction.commit().await?;
        recipients
    };
    assert_eq!(recipients_before, vec![revoked_user_id]);

    let inbox_before = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/me/notifications/inbox")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {revoked_user_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(inbox_before.status(), StatusCode::OK);
    let inbox_before: serde_json::Value =
        serde_json::from_slice(&to_bytes(inbox_before.into_body(), usize::MAX).await?)?;
    assert_eq!(inbox_before["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        inbox_before["items"][0]["lastMessagePreview"].as_str(),
        Some("private notification contents")
    );

    // Leave the private conversation participant row behind to model a normal
    // project membership revocation. Neither notification channel may treat
    // that stale participant row as authorization.
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&project_id, &revoked_user_id],
            )
            .await?;
    }

    let recipients_after = {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let conversation =
            crate::conversations::load_conversation_record(&transaction, &conversation_id)
                .await
                .map_err(|error| {
                    controller_error("load notification conversation after revocation", error)
                })?;
        let recipients = crate::notifications::load_notification_recipients(
            &transaction,
            &conversation,
            Some(owner_user_id),
        )
        .await?;
        transaction.commit().await?;
        recipients
    };
    assert!(recipients_after.is_empty());

    let inbox_after = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/me/notifications/inbox")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {revoked_user_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(inbox_after.status(), StatusCode::OK);
    let inbox_after: serde_json::Value =
        serde_json::from_slice(&to_bytes(inbox_after.into_body(), usize::MAX).await?)?;
    assert_eq!(inbox_after["items"].as_array().map(Vec::len), Some(0));

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &revoked_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn private_conversation_read_routes_filter_project_nonparticipants() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private conversation read test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;

    let owner_user_id = Uuid::new_v4();
    let project_member_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let private_conversation_id = Uuid::new_v4();
    let public_conversation_id = Uuid::new_v4();
    let private_run_id = Uuid::new_v4();
    let public_run_id = Uuid::new_v4();
    let conversationless_run_id = Uuid::new_v4();
    let private_message_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &project_member_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("private-conversation-reads-{org_id}"),
                    &"Private conversation read test",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, project_type, owner_user_id, status)
                 values ($1, $2, 'customer', $3, 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &project_member_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'private'),
                        ($4, $2, $3, '{}'::jsonb, 'public')",
                &[
                    &private_conversation_id,
                    &project_id,
                    &owner_user_id,
                    &public_conversation_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runs (
                   id, project_id, conversation_id, run_type, status, progress, metadata
                 ) values
                   ($1, $2, $3, 'prompt', 'success', 1, '{}'::jsonb),
                   ($4, $2, $5, 'prompt', 'success', 1, '{}'::jsonb),
                   ($6, $2, null, 'prompt', 'success', 1, '{}'::jsonb)",
                &[
                    &private_run_id,
                    &project_id,
                    &private_conversation_id,
                    &public_run_id,
                    &public_conversation_id,
                    &conversationless_run_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                   id, conversation_id, project_id, run_id, role, content, metadata, created_by
                 ) values ($1, $2, $3, $4, 'user', 'private message', '{}'::jsonb, $5)",
                &[
                    &private_message_id,
                    &private_conversation_id,
                    &project_id,
                    &private_run_id,
                    &owner_user_id,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "private-conversation-reads",
    );
    let project_member_token =
        crate::auth::issue_controller_token(&config, &project_member_user_id)
            .map_err(|error| controller_error("issue project member token", error))?
            .token;
    let state = build_test_state(pool.clone(), config);
    let app = conversations::router()
        .merge(runs::router())
        .with_state(state);

    for uri in [
        format!("/conversations/{private_conversation_id}/messages"),
        format!("/conversations/{private_conversation_id}/runs"),
        format!("/runs/{private_run_id}/result"),
        format!("/runs?runId={private_run_id}"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {project_member_token}"),
                    )
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    let filtered_runs = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/runs?projectId={project_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {project_member_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(filtered_runs.status(), StatusCode::OK);
    let filtered_body = to_bytes(filtered_runs.into_body(), usize::MAX).await?;
    let filtered_json: serde_json::Value = serde_json::from_slice(&filtered_body)?;
    let filtered_rows = filtered_json
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("runs response was not an array"))?;
    assert!(!filtered_rows
        .iter()
        .any(|run| run["id"] == json!(private_run_id)));
    assert!(filtered_rows
        .iter()
        .any(|run| run["id"] == json!(public_run_id)));
    assert!(filtered_rows
        .iter()
        .any(|run| run["id"] == json!(conversationless_run_id)));

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'member', $3)",
                &[
                    &private_conversation_id,
                    &project_member_user_id,
                    &owner_user_id,
                ],
            )
            .await?;
    }

    for uri in [
        format!("/conversations/{private_conversation_id}/messages"),
        format!("/conversations/{private_conversation_id}/runs"),
        format!("/runs/{private_run_id}/result"),
        format!("/runs?runId={private_run_id}"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {project_member_token}"),
                    )
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
    }

    let participant_runs = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/runs?projectId={project_id}"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {project_member_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(participant_runs.status(), StatusCode::OK);
    let participant_body = to_bytes(participant_runs.into_body(), usize::MAX).await?;
    let participant_json: serde_json::Value = serde_json::from_slice(&participant_body)?;
    assert!(participant_json
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("runs response was not an array"))?
        .iter()
        .any(|run| run["id"] == json!(private_run_id)));

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &project_member_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

async fn ensure_agent_context_cards_test_table(pool: &PgPool) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "create table if not exists agent_context_cards (
              id uuid primary key default gen_random_uuid(),
              user_id uuid not null references auth.users(id) on delete cascade,
              project_id uuid not null references projects(id) on delete cascade,
              agent_id uuid not null references user_agents(id) on delete cascade,
              scope_kind text not null,
              scope_id text not null,
              title text,
              context text not null,
              metadata jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now(),
              unique (user_id, project_id, agent_id, scope_kind, scope_id)
            );",
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn tunnel_routes_issue_list_revoke() -> anyhow::Result<()> {
    use axum::http::{HeaderMap, HeaderValue};

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping tunnel tests: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 VALUES ($1, $2, 'self-hosted', 'ready', 600, now())",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now() - interval '1 minute', now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let http_client = reqwest::Client::new();
    let tunnel_broker: DynTunnelBroker = Arc::new(StubTunnelBroker::default());
    let ota_registry = test_ota_registry(&config);
    let state = AppState {
        config: config.clone(),
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client,
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: Some(tunnel_broker.clone()),
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };
    let mut events_rx = state.events.subscribe();

    let headers = {
        let mut map = HeaderMap::new();
        map.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer service-role-token"),
        );
        map
    };

    let request_body = json!({
        "runtimeId": runtime_id.to_string(),
        "runtimeLeaseId": lease_id.to_string()
    });
    let app = tunnels::router().with_state(state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/tunnels/request"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    headers
                        .get(axum::http::header::AUTHORIZATION)
                        .unwrap()
                        .clone(),
                )
                .body(Body::from(request_body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "request body: {}",
        String::from_utf8_lossy(&bytes)
    );
    let issued: serde_json::Value = serde_json::from_slice(&bytes)?;
    let tunnel_id = issued["tunnelId"].as_str().unwrap().to_string();
    assert_eq!(issued["provider"].as_str(), Some("self_hosted"));
    assert_eq!(issued["status"].as_str(), Some("active"));
    assert!(issued["credentials"].is_object());
    assert_eq!(
        issued["credentials"]["token"].as_str(),
        Some("test-secret-tunnel-token")
    );

    let grant_event = timeout(std::time::Duration::from_secs(1), events_rx.recv())
        .await
        .expect("grant event timeout")
        .expect("grant event");
    assert_eq!(grant_event.kind, "tunnel.grant_requested");
    assert_eq!(grant_event.project_id, Some(project_id));
    assert_eq!(
        grant_event
            .data
            .get("tunnelId")
            .and_then(|value| value.as_str()),
        Some(tunnel_id.as_str())
    );
    assert!(grant_event.data.get("credentials").is_none());
    assert!(!grant_event
        .data
        .to_string()
        .contains("test-secret-tunnel-token"));

    let status_app = tunnels::router().with_state(state.clone());
    let status_response = status_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/tunnels/{tunnel_id}/status"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer internal"),
                )
                .body(Body::from(json!({ "status": "revoking" }).to_string()))?,
        )
        .await?;
    let status_code = status_response.status();
    let status_bytes = to_bytes(status_response.into_body(), usize::MAX).await?;
    assert_eq!(
        status_code,
        StatusCode::OK,
        "status response body: {}",
        String::from_utf8_lossy(&status_bytes)
    );
    let status_json: serde_json::Value = serde_json::from_slice(&status_bytes)?;
    assert_eq!(status_json["status"].as_str(), Some("revoking"));

    let status_event = timeout(std::time::Duration::from_secs(1), events_rx.recv())
        .await
        .expect("status event timeout")
        .expect("status event");
    assert_eq!(status_event.kind, "tunnel.status_updated");
    assert_eq!(
        status_event
            .data
            .get("tunnelId")
            .and_then(|value| value.as_str()),
        Some(tunnel_id.as_str())
    );

    let connection = pool.get().await?;
    let row = connection
        .query_one(
            "SELECT status, hostname FROM runtime_tunnel_grants WHERE project_id = $1",
            &[&project_id],
        )
        .await?;
    let status: String = row.get("status");
    assert_eq!(status, "revoking");
    let hostname: String = row.get("hostname");
    assert!(hostname.contains("instafy-test"));

    let list_app = tunnels::router().with_state(state.clone());
    let list_response = list_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/tunnels"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    headers
                        .get(axum::http::header::AUTHORIZATION)
                        .unwrap()
                        .clone(),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_bytes = to_bytes(list_response.into_body(), usize::MAX).await?;
    let list_json: serde_json::Value = serde_json::from_slice(&list_bytes)?;
    assert_eq!(
        list_json["projectId"].as_str(),
        Some(project_id.to_string().as_str())
    );
    assert_eq!(list_json["grants"].as_array().map(|arr| arr.len()), Some(1));

    let revoke_app = tunnels::router().with_state(state.clone());
    let revoke_response = revoke_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/tunnels/{tunnel_id}/revoke"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    headers
                        .get(axum::http::header::AUTHORIZATION)
                        .unwrap()
                        .clone(),
                )
                .body(Body::from(json!({}).to_string()))?,
        )
        .await?;
    assert_eq!(revoke_response.status(), StatusCode::OK);
    let revoke_bytes = to_bytes(revoke_response.into_body(), usize::MAX).await?;
    let revoked: serde_json::Value = serde_json::from_slice(&revoke_bytes)?;
    assert_eq!(
        revoked["status"],
        serde_json::Value::String("revoked".into())
    );

    let revoke_event = timeout(std::time::Duration::from_secs(1), events_rx.recv())
        .await
        .expect("revoke event timeout")
        .expect("revoke event");
    assert_eq!(revoke_event.kind, "tunnel.grant_revoked");
    assert_eq!(revoke_event.project_id, Some(project_id));
    assert_eq!(
        revoke_event
            .data
            .get("tunnelId")
            .and_then(|value| value.as_str()),
        Some(tunnel_id.as_str())
    );

    // Issue a second tunnel and ensure the helper revokes it automatically.
    let runtime_id_second = Uuid::new_v4();
    let lease_id_second = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 VALUES ($1, $2, 'self-hosted', 'ready', 600, now())",
                &[&runtime_id_second, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now() - interval '30 seconds', now())",
                &[&lease_id_second, &project_id, &runtime_id_second],
            )
            .await?;
    }

    let second_request = json!({
        "runtimeId": runtime_id_second.to_string(),
        "runtimeLeaseId": lease_id_second.to_string()
    });
    let second_app = tunnels::router().with_state(state.clone());
    let second_response = second_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/tunnels/request"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    headers
                        .get(axum::http::header::AUTHORIZATION)
                        .unwrap()
                        .clone(),
                )
                .body(Body::from(second_request.to_string()))?,
        )
        .await?;
    assert_eq!(second_response.status(), StatusCode::OK);
    let second_bytes = to_bytes(second_response.into_body(), usize::MAX).await?;
    let issued_second: serde_json::Value = serde_json::from_slice(&second_bytes)?;
    let tunnel_id_second = issued_second["tunnelId"]
        .as_str()
        .expect("second tunnel id")
        .to_string();

    let second_grant_event = timeout(std::time::Duration::from_secs(1), events_rx.recv())
        .await
        .expect("second grant event timeout")
        .expect("second grant event");
    assert_eq!(second_grant_event.kind, "tunnel.grant_requested");
    assert_eq!(
        second_grant_event
            .data
            .get("tunnelId")
            .and_then(|value| value.as_str()),
        Some(tunnel_id_second.as_str())
    );

    let mut failing_revoke_state = state.clone();
    failing_revoke_state.tunnel_broker = Some(Arc::new(StubTunnelBroker { fail_revoke: true }));
    let failed_revoke = revoke_tunnels_for_scope(
        &failing_revoke_state,
        &project_id,
        Some(&runtime_id_second),
        None,
        "test.failed_auto_revoke",
    )
    .await;
    assert!(failed_revoke.is_err());
    let status_after_failed_revoke: String = pool
        .get()
        .await?
        .query_one(
            "SELECT status FROM runtime_tunnel_grants WHERE tunnel_id = $1",
            &[&tunnel_id_second],
        )
        .await?
        .get("status");
    assert_eq!(status_after_failed_revoke, "active");

    let auto_revoked = revoke_tunnels_for_scope(
        &state,
        &project_id,
        Some(&runtime_id_second),
        None,
        "test.auto_revoke",
    )
    .await
    .map_err(|(status, payload)| {
        anyhow::anyhow!("auto revoke failed ({status}): {}", payload.0.message)
    })?;
    assert_eq!(auto_revoked, 1);

    let auto_revoke_event = timeout(std::time::Duration::from_secs(1), events_rx.recv())
        .await
        .expect("auto revoke event timeout")
        .expect("auto revoke event");
    assert_eq!(auto_revoke_event.kind, "tunnel.grant_revoked");
    assert_eq!(
        auto_revoke_event
            .data
            .get("tunnelId")
            .and_then(|value| value.as_str()),
        Some(tunnel_id_second.as_str())
    );

    let status_row = pool
        .get()
        .await?
        .query_one(
            "SELECT status FROM runtime_tunnel_grants WHERE tunnel_id = $1",
            &[&tunnel_id_second],
        )
        .await?;
    let second_status: String = status_row.get("status");
    assert_eq!(second_status, "revoked");

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn provider_request_dispatch_round_trips_tool_response() -> anyhow::Result<()> {
    use axum::http::HeaderValue;

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping provider request route test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let requesting_provider_id = "camera:android-test-device";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .batch_execute(
                "
                create table if not exists project_integrations (
                  id uuid primary key,
                  project_id uuid not null,
                  provider text not null,
                  status text not null,
                  connection_type text not null,
                  credential_id uuid,
                  metadata jsonb not null default '{}'::jsonb,
                  required_scopes jsonb not null default '[]'::jsonb,
                  capabilities jsonb not null default '[]'::jsonb,
                  created_by uuid,
                  created_at timestamptz not null default now(),
                  updated_at timestamptz not null default now(),
                  unique (project_id, provider)
                );
                ",
            )
            .await?;
        connection
            .execute(
                "insert into project_integrations (
                    id,
                    project_id,
                    provider,
                    status,
                    connection_type,
                    metadata,
                    capabilities
                 ) values ($1, $2, $3, 'attached', 'native_runtime', $4::jsonb, $5::jsonb)",
                &[
                    &Uuid::new_v4(),
                    &project_id,
                    &requesting_provider_id,
                    &PgJson(&json!({
                        "attached": true,
                        "enabled": true,
                        "selectedDevice": {
                            "transport": "native_camera",
                            "identifier": "android-test-device",
                            "address": "android-test-device",
                            "name": "Pixel Test",
                            "nativePlatform": "android"
                        }
                    })),
                    &PgJson(&json!(["camera_observation"])),
                ],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "provider-request-dispatch",
        ),
    );
    let app = crate::provider_requests::router().with_state(state);
    let worker_app = app.clone();
    let worker_project_id = project_id;

    let worker = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let list_response = worker_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/projects/{worker_project_id}/provider-requests?providerId={requesting_provider_id}"
                    ))
                    .header(
                        axum::http::header::AUTHORIZATION,
                        HeaderValue::from_static("Bearer service-role-token"),
                    )
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("list response");
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .expect("list body");
        let list_json: serde_json::Value = serde_json::from_slice(&list_body).expect("list json");
        let request_id = list_json
            .as_array()
            .and_then(|items| items.first())
            .and_then(|item| item.get("id"))
            .and_then(serde_json::Value::as_str)
            .expect("request id")
            .to_string();

        let claim_response = worker_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/projects/{worker_project_id}/provider-requests/{request_id}/claim"
                    ))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        HeaderValue::from_static("Bearer service-role-token"),
                    )
                    .body(Body::from(
                        json!({
                            "providerId": requesting_provider_id,
                            "deviceId": "android-test-device",
                            "deviceLabel": "Pixel Test"
                        })
                        .to_string(),
                    ))
                    .expect("claim request"),
            )
            .await
            .expect("claim response");
        assert_eq!(claim_response.status(), StatusCode::OK);

        let complete_response = worker_app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/projects/{worker_project_id}/provider-requests/{request_id}/complete"
                    ))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        HeaderValue::from_static("Bearer service-role-token"),
                    )
                    .body(Body::from(
                        json!({
                            "providerId": requesting_provider_id,
                            "deviceId": "android-test-device",
                            "response": {
                                "ok": true,
                                "providerId": requesting_provider_id,
                                "name": "instafy.camera.capture_photo",
                                "value": {
                                    "capture": {
                                        "captureId": "capture-1",
                                        "backend": "phone_camera",
                                        "lens": "front",
                                        "capturedAt": "2026-04-01T10:00:00.000Z"
                                    }
                                }
                            }
                        })
                        .to_string(),
                    ))
                    .expect("complete request"),
            )
            .await
            .expect("complete response");
        assert_eq!(complete_response.status(), StatusCode::OK);
    });

    let dispatch_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/provider-tools/call"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::from(
                    json!({
                        "providerId": requesting_provider_id,
                        "name": "instafy.camera.capture_photo",
                        "arguments": {
                            "lens": "front"
                        },
                        "timeoutMs": 10000
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    worker.await?;

    assert_eq!(dispatch_response.status(), StatusCode::OK);
    let dispatch_body = to_bytes(dispatch_response.into_body(), usize::MAX).await?;
    let dispatch_json: serde_json::Value = serde_json::from_slice(&dispatch_body)?;
    assert_eq!(
        dispatch_json.get("ok").and_then(serde_json::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        dispatch_json
            .get("value")
            .and_then(|value| value.get("capture"))
            .and_then(|value| value.get("captureId"))
            .and_then(serde_json::Value::as_str),
        Some("capture-1")
    );

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from project_provider_requests where project_id = $1",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "delete from project_integrations where project_id = $1",
                &[&project_id],
            )
            .await?;
        connection
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
    }

    Ok(())
}

#[tokio::test]
async fn provider_device_heartbeat_records_presence_and_lists_by_family() -> anyhow::Result<()> {
    use axum::http::HeaderValue;

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping provider device route test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let provider_id = "camera:ios-test-device";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .batch_execute(
                "
                create table if not exists project_integrations (
                  id uuid primary key,
                  project_id uuid not null,
                  provider text not null,
                  status text not null,
                  connection_type text not null,
                  credential_id uuid,
                  metadata jsonb not null default '{}'::jsonb,
                  required_scopes jsonb not null default '[]'::jsonb,
                  capabilities jsonb not null default '[]'::jsonb,
                  created_by uuid,
                  created_at timestamptz not null default now(),
                  updated_at timestamptz not null default now(),
                  unique (project_id, provider)
                );
                ",
            )
            .await?;
        connection
            .execute(
                "insert into project_integrations (
                    id,
                    project_id,
                    provider,
                    status,
                    connection_type,
                    metadata,
                    capabilities
                 ) values ($1, $2, $3, 'attached', 'native_runtime', $4::jsonb, $5::jsonb)",
                &[
                    &Uuid::new_v4(),
                    &project_id,
                    &provider_id,
                    &PgJson(&json!({
                        "attached": true,
                        "enabled": true,
                        "selectedDevice": {
                            "transport": "native_camera",
                            "identifier": "ios-test-device",
                            "address": "ios-test-device",
                            "name": "Taylor iPhone",
                            "nativePlatform": "ios"
                        }
                    })),
                    &PgJson(&json!(["camera_observation"])),
                ],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "provider-device-heartbeat",
        ),
    );
    let app = crate::provider_devices::router().with_state(state);

    let heartbeat_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/provider-devices/heartbeat"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::from(
                    json!({
                        "providerId": provider_id,
                        "deviceId": "ios-test-device",
                        "deviceLabel": "Taylor iPhone",
                        "platform": "ios",
                        "status": "ready",
                        "connectionType": "native_runtime",
                        "metadata": {
                            "permissionGranted": true,
                            "selectedLens": "front"
                        }
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(heartbeat_response.status(), StatusCode::OK);
    let heartbeat_body = to_bytes(heartbeat_response.into_body(), usize::MAX).await?;
    let heartbeat_json: serde_json::Value = serde_json::from_slice(&heartbeat_body)?;
    assert_eq!(
        heartbeat_json
            .get("providerFamilyId")
            .and_then(serde_json::Value::as_str),
        Some("camera")
    );
    assert_eq!(
        heartbeat_json
            .get("presenceStatus")
            .and_then(serde_json::Value::as_str),
        Some("online")
    );

    let list_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/projects/{project_id}/provider-devices?providerFamilyId=camera"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::empty())
                .expect("request"),
        )
        .await?;

    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = to_bytes(list_response.into_body(), usize::MAX).await?;
    let list_json: serde_json::Value = serde_json::from_slice(&list_body)?;
    let first = list_json
        .as_array()
        .and_then(|items| items.first())
        .cloned()
        .expect("provider device row");
    assert_eq!(
        first.get("providerId").and_then(serde_json::Value::as_str),
        Some(provider_id)
    );
    assert_eq!(
        first
            .get("metadata")
            .and_then(|value| value.get("selectedLens"))
            .and_then(serde_json::Value::as_str),
        Some("front")
    );

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from project_provider_devices where project_id = $1",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "delete from project_integrations where project_id = $1",
                &[&project_id],
            )
            .await?;
        connection
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
    }

    Ok(())
}

#[tokio::test]
async fn project_integration_routes_round_trip_provider_family_selection_metadata(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping integration route test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "integration-family-selection",
        ),
    );
    let app = crate::integrations::router().with_state(state);

    let upsert_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!(
                    "/projects/{project_id}/integrations/camera%3Aios-remote-device"
                ))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::from(
                    json!({
                        "status": "attached",
                        "connectionType": "native_runtime",
                        "capabilities": ["camera_observation"],
                        "metadata": {
                            "attached": true,
                            "enabled": true,
                            "providerFamilySelection": {
                                "familyId": "camera",
                                "preferredProviderId": "camera:ios-remote-device",
                                "preferredDevice": {
                                    "transport": "native_camera",
                                    "identifier": "ios-remote-device",
                                    "address": "ios-remote-device",
                                    "name": "Taylor iPhone",
                                    "nativePlatform": "ios"
                                },
                                "updatedAt": "2026-04-04T10:10:00.000Z"
                            }
                        }
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(upsert_response.status(), StatusCode::OK);
    let upsert_body = to_bytes(upsert_response.into_body(), usize::MAX).await?;
    let upsert_json: serde_json::Value = serde_json::from_slice(&upsert_body)?;
    assert_eq!(
        upsert_json
            .get("metadata")
            .and_then(|value| value.get("providerFamilySelection"))
            .and_then(|value| value.get("preferredProviderId"))
            .and_then(serde_json::Value::as_str),
        Some("camera:ios-remote-device")
    );

    let list_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/integrations"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = to_bytes(list_response.into_body(), usize::MAX).await?;
    let list_json: serde_json::Value = serde_json::from_slice(&list_body)?;
    let integration = list_json
        .as_array()
        .and_then(|entries| entries.first())
        .expect("integration item");
    assert_eq!(
        integration
            .get("metadata")
            .and_then(|value| value.get("providerFamilySelection"))
            .and_then(|value| value.get("preferredDevice"))
            .and_then(|value| value.get("name"))
            .and_then(serde_json::Value::as_str),
        Some("Taylor iPhone")
    );

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from project_integrations where project_id = $1",
                &[&project_id],
            )
            .await?;
        connection
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
    }

    Ok(())
}

#[tokio::test]
async fn hosted_runtime_sweep_burns_credits() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping hosted runtime billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let starting_balance: i32 = 50;
    let burn_interval_seconds: i64 = 600;

    {
        let connection = pool.get().await?;
        let slug = format!("test-org-{}", &org_id.to_string()[..8]);
        connection
            .execute(
                "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)",
                &[&org_id, &slug, &"Hosted Runtime Billing Test"],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO projects (id, org_id, project_type, status) VALUES ($1, $2, 'customer', 'active')",
                &[&project_id, &org_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO org_credit_balances (org_id, balance, credit_limit)
                 VALUES ($1, $2, 0)
                 ON CONFLICT (org_id) DO UPDATE SET balance = excluded.balance, credit_limit = excluded.credit_limit, updated_at = now()",
                &[&org_id, &starting_balance],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds)
                 VALUES ($1, $2, 'instafy-cloud', 'ready', 600)",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now() - interval '1 minute', now() - interval '1 minute')",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    // Enable hosted runtime metering for instafy-cloud providers. The effective burn amount for
    // the canonical instafy-cloud provider is derived from the free plan cadence.
    config.hosted_runtime_credit_burn_amount = 1;
    config.hosted_runtime_credit_burn_interval_seconds = burn_interval_seconds;

    let instafy_cloud_provider = RuntimeProviderConfig {
        id: "instafy-cloud".to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    };

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    provider_configs.insert("instafy-cloud".to_string(), instafy_cloud_provider.clone());
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);

    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let (burn_amount, _) = crate::credits::resolve_hosted_runtime_credit_burn_config_for_provider(
        &state,
        &instafy_cloud_provider,
    );
    runtime::sweep_hosted_runtime_credit_usage(&state).await?;

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "SELECT balance FROM org_credit_balances WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        let balance: i32 = row.get("balance");
        assert_eq!(balance, starting_balance - burn_amount);

        let rows = connection
            .query(
                "SELECT delta FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND reason = 'hosted_runtime'",
                &[&org_id, &project_id],
            )
            .await?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<_, i32>("delta"), -burn_amount);
    }

    // A second sweep within the same bucket should not double-burn.
    runtime::sweep_hosted_runtime_credit_usage(&state).await?;

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "SELECT balance FROM org_credit_balances WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        let balance: i32 = row.get("balance");
        assert_eq!(balance, starting_balance - burn_amount);

        let rows = connection
            .query(
                "SELECT count(*)::int as count FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND reason = 'hosted_runtime'",
                &[&org_id, &project_id],
            )
            .await?;
        let count = rows
            .first()
            .and_then(|row| row.try_get::<_, i32>("count").ok())
            .unwrap_or(0);
        assert_eq!(count, 1);
    }

    cleanup_org(&pool, &org_id).await?;
    Ok(())
}

#[tokio::test]
async fn tunnel_broker_acl_hook_burns_credits() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping tunnel broker hook billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let burn_amount: i32 = 4;
    let hook_secret = "hook-secret";
    let idempotency_key = "acl-test-key-1";

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    config.tunnel_broker_hook_secret = Some(hook_secret.to_string());
    config.tunnel_credit_burn_amount = burn_amount;

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);
    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let app = tunnels::router().with_state(state.clone());

    let missing_idempotency = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/tunnel-broker/hooks/acl")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {hook_secret}"),
                )
                .body(Body::from(
                    json!({
                        "intent": "grant",
                        "project_id": project_id.to_string()
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(missing_idempotency.status(), StatusCode::OK);
    let missing_body = to_bytes(missing_idempotency.into_body(), usize::MAX).await?;
    let missing_json: serde_json::Value = serde_json::from_slice(&missing_body)?;
    assert_eq!(missing_json["allowed"].as_bool(), Some(false));
    assert!(
        missing_json["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("idempotency_key"),
        "unexpected reason: {missing_json:?}"
    );

    let allowed = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/tunnel-broker/hooks/acl")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {hook_secret}"),
                )
                .body(Body::from(
                    json!({
                        "intent": "grant",
                        "project_id": project_id.to_string(),
                        "idempotency_key": idempotency_key
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(allowed.status(), StatusCode::OK);
    let allowed_body = to_bytes(allowed.into_body(), usize::MAX).await?;
    let allowed_json: serde_json::Value = serde_json::from_slice(&allowed_body)?;
    assert_eq!(allowed_json["allowed"].as_bool(), Some(true));

    let org_id = {
        let connection = pool.get().await?;
        let row = connection
            .query_one("SELECT org_id FROM projects WHERE id = $1", &[&project_id])
            .await?;
        row.get::<_, Option<Uuid>>("org_id")
            .expect("project org_id should be set by ensure_project_org")
    };

    {
        let connection = pool.get().await?;
        let rows = connection
            .query(
                "SELECT delta FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND reason = 'tunnel_grant' AND idempotency_key = $3",
                &[&org_id, &project_id, &idempotency_key],
            )
            .await?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<_, i32>("delta"), -burn_amount);
    }

    // Retrying the ACL hook with the same idempotency key should not double-burn.
    let allowed_retry = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/tunnel-broker/hooks/acl")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {hook_secret}"),
                )
                .body(Body::from(
                    json!({
                        "intent": "grant",
                        "project_id": project_id.to_string(),
                        "idempotency_key": idempotency_key
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(allowed_retry.status(), StatusCode::OK);

    {
        let connection = pool.get().await?;
        let rows = connection
            .query(
                "SELECT count(*)::int as count FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND idempotency_key = $3",
                &[&org_id, &project_id, &idempotency_key],
            )
            .await?;
        let count = rows
            .first()
            .and_then(|row| row.try_get::<_, i32>("count").ok())
            .unwrap_or(0);
        assert_eq!(count, 1);
    }

    cleanup_org(&pool, &org_id).await?;
    Ok(())
}

#[tokio::test]
async fn tunnel_request_burns_credits_when_not_using_broker_hook() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping tunnel entitlement billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let burn_amount: i32 = 6;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, idle_ttl_seconds, last_seen_at
                 ) VALUES ($1, $2, 'self-hosted', 'ready', 600, now())",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) VALUES ($1, $2, $3, 'active', now() - interval '1 minute', now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    config.tunnel_credit_burn_amount = burn_amount;
    config.tunnel_broker_hook_secret = None;

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);
    let tunnel_broker: DynTunnelBroker = Arc::new(StubTunnelBroker::default());
    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: Some(tunnel_broker.clone()),
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let request_body = json!({
        "runtimeId": runtime_id.to_string(),
        "runtimeLeaseId": lease_id.to_string()
    });
    let app = tunnels::router().with_state(state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/tunnels/request"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::from(request_body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "tunnel request failed: {}",
        String::from_utf8_lossy(&bytes)
    );

    let org_id = {
        let connection = pool.get().await?;
        let row = connection
            .query_one("SELECT org_id FROM projects WHERE id = $1", &[&project_id])
            .await?;
        row.get::<_, Option<Uuid>>("org_id")
            .expect("project org_id should be set by ensure_project_org")
    };

    {
        let connection = pool.get().await?;
        let rows = connection
            .query(
                "SELECT delta FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND reason = 'tunnel_grant'",
                &[&org_id, &project_id],
            )
            .await?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<_, i32>("delta"), -burn_amount);
    }

    cleanup_org(&pool, &org_id).await?;
    Ok(())
}

#[tokio::test]
async fn post_commit_receipt_emits_workspace_commit_event() -> anyhow::Result<()> {
    use axum::http::{HeaderMap, HeaderValue};

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping workspace commit test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let origin_instance_id = Uuid::new_v4();

    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols)
                 VALUES ($1, $2, 'desktop', 'https://origin', ARRAY['webdav']::text[])",
                &[&origin_id, &project_id],
            )
            .await?;
        let capabilities = PgJson(json!({
            "_instafySelfHostedAccess": {
                "mode": "private",
                "ownerUserId": user_id.to_string(),
            }
        }));
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, capabilities
                 ) VALUES ($1, $2, 'self-hosted', 'ready', 600, now(), $3)",
                &[&runtime_id, &project_id, &capabilities],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO origin_instances (
                     id, project_id, runtime_id, origin_id, required, mode,
                     status, endpoint, protocols, metadata
                 ) VALUES (
                     $1, $2, $3, $4, true, 'desktop',
                     'online', 'https://origin', ARRAY['webdav']::text[], '{}'::jsonb
                 )",
                &[&origin_instance_id, &project_id, &runtime_id, &origin_id],
            )
            .await?;
    }

    let lease_id = match acquire_lease(&pool, &project_id, Some(&user_id), None, 300, None).await? {
        LeaseAcquireOutcome::Granted(record) | LeaseAcquireOutcome::Renewed(record) => record.id,
        other => panic!("expected granted lease, got {other:?}"),
    };

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);

    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let mut events_rx = state.events.subscribe();

    let token = mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: vec!["origin.apply".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
    .expect("mint origin apply token");

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token.token)).unwrap(),
    );

    let request = CommitReceiptBody {
        project_id: project_id.to_string(),
        origin_id: origin_id.to_string(),
        lease_id: Some(lease_id.to_string()),
        user_id: Some(user_id.to_string()),
        rev: "rev-123".to_string(),
        bytes_written: Some(2048),
        file_count: Some(5),
        duration_ms: Some(1200),
        metadata: Some(json!({ "paths": ["src/App.tsx"] })),
    };

    let response = post_commit_receipt(
        axum::extract::State(state.clone()),
        headers,
        AxumJson(request),
    )
    .await
    .expect("commit receipt recorded");

    assert_eq!(response.project_id, project_id);
    assert_eq!(response.origin_id, origin_id);
    assert_eq!(response.rev, "rev-123");

    let event = events_rx.try_recv().expect("workspace.commit event");
    assert_eq!(event.kind, "workspace.commit");
    assert_eq!(event.project_id, Some(project_id));
    let rev = event
        .data
        .get("rev")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    assert_eq!(rev, "rev-123");

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn targeted_conversation_message_is_leased_by_its_ready_runtime() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping targeted conversation lease regression: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();

    let test_result: anyhow::Result<()> = async {
        ensure_test_user(&pool, &user_id).await?;
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name)
                     values ($1, $2, 'Targeted lease regression')",
                    &[&org_id, &format!("targeted-lease-regression-{org_id}")],
                )
                .await?;
            connection
                .execute(
                    "insert into org_memberships (org_id, user_id, role)
                     values ($1, $2, 'owner')",
                    &[&org_id, &user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, owner_user_id, project_type, status)
                     values ($1, $2, $3, 'customer', 'active')",
                    &[&project_id, &org_id, &user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into conversations (id, project_id, created_by, metadata, visibility)
                     values ($1, $2, $3, '{}'::jsonb, 'public')",
                    &[&conversation_id, &project_id, &user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtimes (
                         id, project_id, provider, status, endpoint_url, task_ref,
                         idle_ttl_seconds, last_seen_at, capabilities
                     ) values (
                         $1, $2, 'self-hosted', 'ready', 'http://runtime.invalid',
                         $3, 600, now(), $4
                     )",
                    &[
                        &runtime_id,
                        &project_id,
                        &format!("targeted-lease-regression-{runtime_id}"),
                        &PgJson(json!({
                            "agent": true,
                            "origin": true,
                            "_instafySelfHostedAccess": {
                                "mode": "private",
                                "ownerUserId": user_id.to_string(),
                            }
                        })),
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into user_credentials (
                         id, user_id, kind, label, nonce_b64, ciphertext_b64,
                         metadata, is_default
                     ) values (
                         $1, $2, 'openai_api_key', 'Targeted lease regression',
                         'test-nonce', 'test-ciphertext', '{}'::jsonb, true
                     )",
                    &[&credential_id, &user_id],
                )
                .await?;
        }

        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "targeted-conversation-lease-regression",
        );
        let owner_token = crate::auth::issue_controller_token(&config, &user_id)
            .map_err(|error| controller_error("issue project owner token", error))?
            .token;
        let state = build_test_state(pool.clone(), config.clone());

        let message_response = conversations::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/conversations/{conversation_id}/messages"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {owner_token}"),
                    )
                    .body(Body::from(
                        json!({
                            "promptText": "Report the current workspace status.",
                            "intent": "question",
                            "runtimeId": runtime_id,
                            "runtimeType": "self-hosted"
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        let message_status = message_response.status();
        let message_body = to_bytes(message_response.into_body(), usize::MAX).await?;
        anyhow::ensure!(
            message_status == StatusCode::OK,
            "targeted message returned {message_status}: {}",
            String::from_utf8_lossy(&message_body)
        );
        let message_payload: serde_json::Value = serde_json::from_slice(&message_body)?;
        let job_id = Uuid::parse_str(
            message_payload["jobId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("targeted message response omitted jobId"))?,
        )?;

        {
            let connection = pool.get().await?;
            let queued_job = connection
                .query_one(
                    "select status, target_runtime_id, leased_by_runtime_id
                     from agent_jobs
                     where id = $1 and project_id = $2 and conversation_id = $3",
                    &[&job_id, &project_id, &conversation_id],
                )
                .await?;
            anyhow::ensure!(queued_job.get::<_, String>("status") == "queued");
            anyhow::ensure!(
                queued_job.get::<_, Option<Uuid>>("target_runtime_id") == Some(runtime_id),
                "queued job was not targeted to the requested runtime"
            );
            anyhow::ensure!(
                queued_job
                    .get::<_, Option<Uuid>>("leased_by_runtime_id")
                    .is_none(),
                "queued job was unexpectedly already leased"
            );
        }

        let agent_token =
            crate::auth::issue_agent_token(&config, &project_id, &runtime_id, None, None)
                .map_err(|error| controller_error("issue runtime-scoped agent token", error))?
                .token;
        let lease_response = agent::router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/agent/lease")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {agent_token}"),
                    )
                    .body(Body::from(
                        json!({
                            "max": 1,
                            "lease_seconds": 120,
                            "runtime_id": runtime_id
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        let lease_status = lease_response.status();
        let lease_body = to_bytes(lease_response.into_body(), usize::MAX).await?;
        anyhow::ensure!(
            lease_status == StatusCode::OK,
            "runtime lease returned {lease_status}: {}",
            String::from_utf8_lossy(&lease_body)
        );
        let lease_payload: serde_json::Value = serde_json::from_slice(&lease_body)?;
        let leased_jobs = lease_payload["jobs"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("agent lease response omitted jobs"))?;
        anyhow::ensure!(leased_jobs.len() == 1, "expected exactly one leased job");
        anyhow::ensure!(leased_jobs[0]["id"] == json!(job_id));
        anyhow::ensure!(leased_jobs[0]["status"] == "leased");

        let connection = pool.get().await?;
        let leased_job = connection
            .query_one(
                "select status, target_runtime_id, leased_by_runtime_id
                 from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        anyhow::ensure!(leased_job.get::<_, String>("status") == "leased");
        anyhow::ensure!(leased_job.get::<_, Option<Uuid>>("target_runtime_id") == Some(runtime_id));
        anyhow::ensure!(
            leased_job.get::<_, Option<Uuid>>("leased_by_runtime_id") == Some(runtime_id)
        );

        Ok(())
    }
    .await;

    let project_cleanup = cleanup_origin_project(&pool, &project_id).await;
    let org_cleanup = cleanup_org(&pool, &org_id).await;
    let user_cleanup = cleanup_test_user(&pool, &user_id).await;
    test_result?;
    project_cleanup?;
    org_cleanup?;
    user_cleanup?;

    Ok(())
}

#[tokio::test]
async fn dispatch_keeps_ready_private_runtime_without_runtime_type() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private runtime dispatch regression: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let preferred_conversation_id = Uuid::new_v4();
    let explicit_conversation_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();

    let test_result: anyhow::Result<()> = async {
        ensure_test_user(&pool, &user_id).await?;
        let mut capabilities = json!({
            "agent": true,
            "origin": true,
        });
        runtime::set_self_hosted_access_attestation(
            capabilities
                .as_object_mut()
                .expect("runtime capabilities are an object"),
            user_id,
        );

        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name)
                     values ($1, $2, 'Private preferred runtime regression')",
                    &[&org_id, &format!("private-preferred-runtime-{org_id}")],
                )
                .await?;
            connection
                .execute(
                    "insert into org_memberships (org_id, user_id, role)
                     values ($1, $2, 'owner')",
                    &[&org_id, &user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, owner_user_id, project_type, status)
                     values ($1, $2, $3, 'customer', 'active')",
                    &[&project_id, &org_id, &user_id],
                )
                .await?;
            for conversation_id in [preferred_conversation_id, explicit_conversation_id] {
                connection
                    .execute(
                        "insert into conversations (id, project_id, created_by, metadata, visibility)
                         values ($1, $2, $3, '{}'::jsonb, 'public')",
                        &[&conversation_id, &project_id, &user_id],
                    )
                    .await?;
            }
            connection
                .execute(
                    "insert into runtimes (
                         id, project_id, provider, status, endpoint_url, task_ref,
                         idle_ttl_seconds, last_seen_at, capabilities
                     ) values (
                         $1, $2, 'self-hosted', 'ready', 'http://runtime.invalid',
                         $3, 600, now(), $4
                     )",
                    &[
                        &runtime_id,
                        &project_id,
                        &format!("private-preferred-runtime-{runtime_id}"),
                        &PgJson(capabilities),
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into user_credentials (
                         id, user_id, kind, label, nonce_b64, ciphertext_b64,
                         metadata, is_default
                     ) values (
                         $1, $2, 'openai_api_key', 'Private preferred runtime regression',
                         'test-nonce', 'test-ciphertext', '{}'::jsonb, true
                     )",
                    &[&credential_id, &user_id],
                )
                .await?;
        }

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "private-preferred-runtime-dispatch",
        );
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: "instafy-cloud".to_string(),
            display_name: "Instafy Cloud".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        }];
        let state = build_test_state(pool.clone(), config);
        state
            .runtime_preferences
            .set_private(
                project_id,
                user_id,
                Some(runtime_id),
                Some("private-test".to_string()),
                Some("Private runtime".to_string()),
            )
            .await;

        for (selection, conversation_id, explicit_runtime_id) in [
            ("preference", preferred_conversation_id, None),
            ("explicit", explicit_conversation_id, Some(runtime_id)),
        ] {
            let mut normalized = dispatch::normalize_dispatch_request(DispatchPromptRequest {
                project_id: Some(project_id.to_string()),
                session_id: None,
                prompt_text: Some("Report the current workspace status.".to_string()),
                intent: Some("question".to_string()),
                plan_seed: None,
                metadata: Some(json!({
                    "agentSelection": {
                        "active": ["octo"],
                        "mentions": ["octo"]
                    }
                })),
                conversation_metadata: None,
                parent_conversation_id: None,
                thread_kind: None,
                tool_limits: None,
                repo: None,
                ui: None,
                priority: None,
                runtime_type: None,
                idle_ttl_seconds: None,
                conversation_id: Some(conversation_id.to_string()),
                runtime_id: explicit_runtime_id.map(|value| value.to_string()),
                runtime_display_name: None,
                prefer_runtime: None,
            })
            .map_err(|error| controller_error("normalize private runtime dispatch", error))?;
            if explicit_runtime_id.is_some() {
                // This is the scheduler's `auto` shape after it has selected a
                // viable existing runtime: an exact runtime ID, no runtime
                // type, and an automation-owned selection source.
                normalized.runtime_source = Some("automation".to_string());
            }

            let response = dispatch::process_dispatch_prompt(
                &state,
                &RequestContext {
                    user_id: Some(user_id),
                    is_service_role: false,
                    scoped_claims: None,
                },
                normalized,
            )
            .await
            .map_err(|error| controller_error("process private runtime dispatch", error))?;

            let run_id = response.run_id.expect("private runtime run id");
            let job_id = response.job_id.expect("private runtime job id");
            let connection = pool.get().await?;
            let job = connection
                .query_one(
                    "select target_runtime_id from agent_jobs where id = $1 and project_id = $2",
                    &[&job_id, &project_id],
                )
                .await?;
            assert_eq!(
                job.get::<_, Option<Uuid>>("target_runtime_id"),
                Some(runtime_id),
                "ready private {selection} runtime must remain pinned"
            );

            let run_metadata: PgJson<serde_json::Value> = connection
                .query_one("select metadata from runs where id = $1", &[&run_id])
                .await?
                .get("metadata");
            assert_eq!(
                run_metadata.0["jobId"],
                json!(job_id.to_string()),
                "ready private {selection} dispatch must persist the exact run job id"
            );
            assert!(
                run_metadata.0.get("runtimeAlert").is_none(),
                "ready private {selection} runtime must not produce an alert: {}",
                run_metadata.0
            );
            let runtime_alert_count: i64 = connection
                .query_one(
                    "select count(*)::bigint
                     from conversation_messages
                     where conversation_id = $1 and metadata->>'kind' = 'runtime_alert'",
                    &[&conversation_id],
                )
                .await?
                .get(0);
            assert_eq!(
                runtime_alert_count, 0,
                "ready private {selection} runtime must not persist an alert"
            );
        }

        let connection = pool.get().await?;
        let runtime = connection
            .query_one(
                "select provider, status from runtimes where id = $1 and project_id = $2",
                &[&runtime_id, &project_id],
            )
            .await?;
        assert_eq!(runtime.get::<_, String>("provider"), "self-hosted");
        assert_eq!(runtime.get::<_, String>("status"), "ready");
        assert_eq!(
            state
                .runtime_preferences
                .get_private(&project_id, &user_id)
                .await
                .and_then(|entry| entry.runtime_id),
            Some(runtime_id),
            "dispatch must not clear the private runtime preference"
        );

        Ok(())
    }
    .await;

    let project_cleanup = cleanup_origin_project(&pool, &project_id).await;
    let org_cleanup = cleanup_org(&pool, &org_id).await;
    let user_cleanup = cleanup_test_user(&pool, &user_id).await;
    test_result?;
    project_cleanup?;
    org_cleanup?;
    user_cleanup?;

    Ok(())
}

#[tokio::test]
async fn shared_browser_internal_token_is_inert_for_workspace_write_routes() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!(
            "skipping Shared Browser workspace-token authorization test: TEST_DATABASE_URL not set"
        );
        return Ok(());
    };

    let user_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let runtime_lease_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();

    let test_result: anyhow::Result<()> = async {
        ensure_test_user(&pool, &user_id).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, capabilities,
                     idle_ttl_seconds, last_seen_at
                 ) values (
                     $1, $2, 'self-hosted', 'ready', $3, 600, now()
                 )",
                &[
                    &runtime_id,
                    &project_id,
                    &PgJson(json!({
                        "agent": true,
                        "origin": true,
                        "_instafySelfHostedAccess": {
                            "mode": "private",
                            "ownerUserId": user_id.to_string(),
                        }
                    })),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) values ($1, $2, $3, 'active', now(), now())",
                &[&runtime_lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &runtime_lease_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, run_type, status, progress, progress_stage)
                 values ($1, $2, 'prompt', 'queued', 0, 'agent:queued')",
                &[&run_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "insert into agent_jobs (
                     id, project_id, run_id, status, payload, priority, target_runtime_id
                 ) values ($1, $2, $3, 'queued', $4, 10, $5)",
                &[
                    &job_id,
                    &project_id,
                    &run_id,
                    &PgJson(json!({
                        "user_id": user_id,
                        "prompt_text": "Click the visible button",
                        "writeIntent": false,
                        "metadata": {
                            "browserTransport": "shared",
                            "writeScope": { "mode": "read_only", "ownedPaths": [] },
                            "runtimeRouting": { "strategy": "exact" },
                            "runtimeExpectations": {
                                "workspaceFileChanges": false,
                                "commandExecution": false,
                                "genericMcpToolExecution": false,
                                "browserExecution": true
                            }
                        }
                    })),
                    &runtime_id,
                ],
            )
            .await?;
        drop(connection);

        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "shared-browser-read-only-workspace-token",
        );
        let agent_token = crate::auth::issue_agent_token(
            &config,
            &project_id,
            &runtime_id,
            Some(&runtime_lease_id),
            None,
        )
        .map_err(|error| controller_error("issue Shared Browser agent token", error))?
        .token;
        let state = build_test_state(pool.clone(), config);
        let lease_response = agent::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/agent/lease")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {agent_token}"),
                    )
                    .body(Body::from(
                        json!({
                            "max": 1,
                            "lease_seconds": 120,
                            "runtime_id": runtime_id,
                            "supports_workspace_token": true
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        let lease_status = lease_response.status();
        let lease_body = to_bytes(lease_response.into_body(), usize::MAX).await?;
        anyhow::ensure!(
            lease_status == StatusCode::OK,
            "Shared Browser lease returned {lease_status}: {}",
            String::from_utf8_lossy(&lease_body)
        );
        let lease_payload: serde_json::Value = serde_json::from_slice(&lease_body)?;
        let leased_job = lease_payload["jobs"]
            .as_array()
            .and_then(|jobs| jobs.first())
            .ok_or_else(|| anyhow::anyhow!("Shared Browser lease omitted its job"))?;
        anyhow::ensure!(leased_job["id"] == json!(job_id));
        let workspace_token = leased_job["workspace_token"]
            .as_str()
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!("Shared Browser lease omitted the separated workspace token")
            })?;
        anyhow::ensure!(
            leased_job["workspace_token_scopes"]
                == json!([
                    crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE,
                    crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE,
                ])
        );

        let origin_app = crate::origins::router().with_state(state);
        let workspace_lease_attempt = origin_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/lease/acquire")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {workspace_token}"),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id,
                            "runtimeId": runtime_id,
                            "userId": user_id,
                            "leaseSeconds": 90,
                            "metadata": {
                                "jobId": job_id,
                                "runId": run_id,
                                "runtimeId": runtime_id
                            }
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(workspace_lease_attempt.status(), StatusCode::FORBIDDEN);
        let workspace_lease_body: serde_json::Value = serde_json::from_slice(
            &to_bytes(workspace_lease_attempt.into_body(), usize::MAX).await?,
        )?;
        assert_eq!(
            workspace_lease_body["message"],
            "this job is not allowed to write the workspace"
        );

        let origin_token_attempt = origin_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/access_token")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {workspace_token}"),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id,
                            "protocol": "http",
                            "scopes": ["fs.write"]
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(origin_token_attempt.status(), StatusCode::FORBIDDEN);
        let origin_token_body: serde_json::Value =
            serde_json::from_slice(&to_bytes(origin_token_attempt.into_body(), usize::MAX).await?)?;
        assert_eq!(
            origin_token_body["message"],
            "this job is not allowed to write the workspace"
        );

        let wrong_runtime_owner = Uuid::new_v4();
        pool.get()
            .await?
            .execute(
                "update runtimes set capabilities = $2 where id = $1",
                &[
                    &runtime_id,
                    &PgJson(json!({
                        "agent": true,
                        "origin": true,
                        "_instafySelfHostedAccess": {
                            "mode": "private",
                            "ownerUserId": wrong_runtime_owner.to_string(),
                        }
                    })),
                ],
            )
            .await?;
        let wrong_owner_attempt = origin_app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/lease/acquire")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {workspace_token}"),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id,
                            "runtimeId": runtime_id,
                            "userId": user_id,
                            "leaseSeconds": 90,
                            "metadata": {
                                "jobId": job_id,
                                "runId": run_id,
                                "runtimeId": runtime_id
                            }
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(wrong_owner_attempt.status(), StatusCode::UNAUTHORIZED);
        let wrong_owner_body: serde_json::Value =
            serde_json::from_slice(&to_bytes(wrong_owner_attempt.into_body(), usize::MAX).await?)?;
        assert_eq!(
            wrong_owner_body["message"],
            "job token subject does not own the private self-hosted runtime"
        );

        Ok(())
    }
    .await;

    let project_cleanup = cleanup_origin_project(&pool, &project_id).await;
    let user_cleanup = cleanup_test_user(&pool, &user_id).await;
    test_result?;
    project_cleanup?;
    user_cleanup?;
    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_leases_queued_work() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let payload = PgJson(json!({ "prompt_text": "test" }));

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority)
             VALUES ($1, $2, NULL, 'queued', $3, 10)",
            &[&job_id, &project_id, &payload],
        )
        .await?;

    let transaction = client.transaction().await?;
    let leased = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease job", error))?;
    assert!(leased.is_some());
    let job = leased.unwrap();
    assert_eq!(job.id, job_id);
    assert_eq!(job.status, "leased");
    assert_eq!(job.project_id, project_id);
    transaction.commit().await?;

    let transaction = client.transaction().await?;
    let retry = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease retry", error))?;
    assert!(retry.is_none());
    transaction.commit().await?;

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_can_filter_for_read_only_batches() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping read-only lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let write_job_id = Uuid::new_v4();
    let read_only_job_id = Uuid::new_v4();
    let write_payload = PgJson(json!({
        "prompt_text": "edit source",
        "metadata": {
            "writeScope": {
                "mode": "owned",
                "ownedPaths": ["src/App.tsx"]
            }
        }
    }));
    let read_only_payload = PgJson(json!({
        "prompt_text": "inspect source",
        "metadata": {
            "writeScope": {
                "mode": "read_only"
            }
        }
    }));

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority)
             VALUES ($1, $2, NULL, 'queued', $3, 10),
                    ($4, $2, NULL, 'queued', $5, 20)",
            &[
                &write_job_id,
                &project_id,
                &write_payload,
                &read_only_job_id,
                &read_only_payload,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let leased = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        true,
        true,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease read-only job", error))?;
    let job = leased.expect("read-only job should be leased");
    assert_eq!(job.id, read_only_job_id);
    transaction.commit().await?;

    let write_status: String = client
        .query_one(
            "SELECT status FROM agent_jobs WHERE id = $1",
            &[&write_job_id],
        )
        .await?
        .get(0);
    assert_eq!(write_status, "queued");

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_scopes_read_only_batch_to_same_team_group() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping read-only batch scope test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let group_a = Uuid::new_v4().to_string();
    let group_a_job_id = Uuid::new_v4();
    let group_b_job_id = Uuid::new_v4();
    let group_a_payload = PgJson(json!({
        "prompt_text": "same team lane",
        "metadata": {
            "writeScope": { "mode": "read_only" },
            "multiAgentPlan": { "role": "worker", "groupId": group_a }
        }
    }));
    let group_b_payload = PgJson(json!({
        "prompt_text": "unrelated team lane",
        "metadata": {
            "writeScope": { "mode": "read_only" },
            "multiAgentPlan": { "role": "worker", "groupId": Uuid::new_v4().to_string() }
        }
    }));

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority)
             VALUES ($1, $2, NULL, 'queued', $3, 20),
                    ($4, $2, NULL, 'queued', $5, 1)",
            &[
                &group_a_job_id,
                &project_id,
                &group_a_payload,
                &group_b_job_id,
                &group_b_payload,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let leased = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        true,
        true,
        false,
        true,
        None,
        Some(group_a.as_str()),
    )
    .await
    .map_err(|error| controller_error("lease scoped read-only batch job", error))?;
    let job = leased.expect("same team read-only sibling should be leased");
    assert_eq!(job.id, group_a_job_id);
    transaction.commit().await?;

    let unrelated_status: String = client
        .query_one(
            "SELECT status FROM agent_jobs WHERE id = $1",
            &[&group_b_job_id],
        )
        .await?
        .get(0);
    assert_eq!(unrelated_status, "queued");

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_can_lease_runtime_spread_jobs_when_preference_pinned(
) -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping runtime-spread lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let normal_job_id = Uuid::new_v4();
    let spread_job_id = Uuid::new_v4();
    let normal_payload = PgJson(json!({
        "prompt_text": "normal untargeted",
        "metadata": {}
    }));
    let spread_payload = PgJson(json!({
        "prompt_text": "spread-safe sibling",
        "metadata": {
            "writeScope": { "mode": "read_only" },
            "runtimeRouting": {
                "strategy": "spread",
                "allowUntargetedAcrossPreferredRuntimes": true
            }
        }
    }));

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority)
             VALUES ($1, $2, NULL, 'queued', $3, 10),
                    ($4, $2, NULL, 'queued', $5, 20)",
            &[
                &normal_job_id,
                &project_id,
                &normal_payload,
                &spread_job_id,
                &spread_payload,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let leased = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        false,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease spread job", error))?;
    let job = leased.expect("runtime-spread job should be leaseable");
    assert_eq!(job.id, spread_job_id);
    transaction.commit().await?;

    let normal_status: String = client
        .query_one(
            "SELECT status FROM agent_jobs WHERE id = $1",
            &[&normal_job_id],
        )
        .await?
        .get(0);
    assert_eq!(normal_status, "queued");

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_never_spreads_personal_browser_work_off_target() -> anyhow::Result<()>
{
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping Personal Browser lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let personal_runtime_id = Uuid::new_v4();
    let other_runtime_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let payload = PgJson(json!({
        "prompt_text": "use my signed-in browser",
        "user_id": teammate_user_id.to_string(),
        "metadata": {
            "browser_transport": "desktop_personal",
            "runtimeRouting": {
                "strategy": "spread",
                "allowUntargetedAcrossPreferredRuntimes": true
            }
        }
    }));

    client
        .execute(
            "INSERT INTO runtimes (id, project_id, provider, status, capabilities)
             VALUES ($1, $2, 'self-hosted', 'ready', $3)",
            &[
                &personal_runtime_id,
                &project_id,
                &PgJson(json!({
                    "personalBrowser": {
                        "enabled": true,
                        "ownerUserId": owner_user_id.to_string(),
                    }
                })),
            ],
        )
        .await?;

    client
        .execute(
            "INSERT INTO agent_jobs (
                 id, project_id, conversation_id, status, payload, priority, target_runtime_id
             ) VALUES ($1, $2, NULL, 'queued', $3, 10, $4)",
            &[&job_id, &project_id, &payload, &personal_runtime_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let wrong_runtime_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&other_runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease Personal Browser job off target", error))?;
    assert!(wrong_runtime_lease.is_none());
    transaction.commit().await?;

    let transaction = client.transaction().await?;
    let wrong_owner_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&personal_runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease Personal Browser job for wrong owner", error))?;
    assert!(wrong_owner_lease.is_none());
    transaction.commit().await?;

    client
        .execute(
            "UPDATE agent_jobs SET payload = jsonb_set(payload, '{user_id}', to_jsonb($2::text)) WHERE id = $1",
            &[&job_id, &owner_user_id.to_string()],
        )
        .await?;

    let transaction = client.transaction().await?;
    let exact_runtime_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&personal_runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease Personal Browser job on target", error))?;
    let leased = exact_runtime_lease.expect("exact Personal Browser runtime should lease the job");
    assert_eq!(leased.id, job_id);
    assert_eq!(leased.leased_by_runtime_id, Some(personal_runtime_id));
    transaction.commit().await?;

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_never_spreads_shared_browser_work_off_target() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping Shared Browser exact-runtime lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let shared_runtime_id = Uuid::new_v4();
    let other_runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let payload = PgJson(json!({
        "prompt_text": "click the visible button",
        "writeIntent": false,
        "metadata": {
            "browserTransport": "shared",
            "writeScope": { "mode": "read_only" },
            "runtimeRouting": {
                "strategy": "spread",
                "allowUntargetedAcrossPreferredRuntimes": true
            }
        }
    }));
    client
        .execute(
            "INSERT INTO agent_jobs (
                 id, project_id, status, payload, priority, target_runtime_id
             ) VALUES ($1, $2, 'queued', $3, 10, $4)",
            &[&job_id, &project_id, &payload, &shared_runtime_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let wrong_runtime_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&other_runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease Shared Browser job off target", error))?;
    assert!(wrong_runtime_lease.is_none());
    transaction.commit().await?;

    let transaction = client.transaction().await?;
    let exact_runtime_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&shared_runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease Shared Browser job on target", error))?;
    let leased = exact_runtime_lease.expect("exact Shared Browser runtime should lease the job");
    assert_eq!(leased.id, job_id);
    assert_eq!(leased.target_runtime_id, Some(shared_runtime_id));
    assert_eq!(leased.leased_by_runtime_id, Some(shared_runtime_id));
    transaction.commit().await?;

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_scopes_grouped_runtime_spread_to_plan_runtimes() -> anyhow::Result<()>
{
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping grouped runtime-spread lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TEMP TABLE runtimes (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                provider text NOT NULL DEFAULT 'instafy-cloud',
                status text NOT NULL,
                capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
                active_lease_id uuid
            );
            CREATE TEMP TABLE runtime_leases (
                id uuid PRIMARY KEY,
                metadata jsonb,
                released_at timestamptz
            );",
        )
        .await?;

    let project_id = Uuid::new_v4();
    let parent_runtime_id = Uuid::new_v4();
    let stale_runtime_id = Uuid::new_v4();
    let fresh_runtime_id = Uuid::new_v4();
    let stale_lease_id = Uuid::new_v4();
    let fresh_lease_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let current_group_id = Uuid::new_v4();
    let old_group_id = Uuid::new_v4();
    let payload = PgJson(json!({
        "prompt_text": "spread-safe sibling",
        "metadata": {
            "writeScope": { "mode": "read_only" },
            "runtimeRouting": {
                "strategy": "spread",
                "allowUntargetedAcrossPreferredRuntimes": true
            },
            "multiAgentPlan": {
                "groupId": current_group_id,
                "parentRuntimeId": parent_runtime_id
            }
        }
    }));

    client
        .execute(
            "INSERT INTO runtime_leases (id, metadata, released_at)
             VALUES ($1, $2, NULL), ($3, $4, NULL)",
            &[
                &stale_lease_id,
                &PgJson(json!({ "groupId": old_group_id })),
                &fresh_lease_id,
                &PgJson(json!({ "groupId": current_group_id })),
            ],
        )
        .await?;
    client
        .execute(
            "INSERT INTO runtimes (id, project_id, status, active_lease_id)
             VALUES ($1, $2, 'ready', $3), ($4, $2, 'ready', $5)",
            &[
                &stale_runtime_id,
                &project_id,
                &stale_lease_id,
                &fresh_runtime_id,
                &fresh_lease_id,
            ],
        )
        .await?;
    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority)
             VALUES ($1, $2, NULL, 'queued', $3, 10)",
            &[&job_id, &project_id, &payload],
        )
        .await?;

    let transaction = client.transaction().await?;
    let stale_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&stale_runtime_id),
        120,
        false,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease grouped spread job for stale runtime", error))?;
    assert!(stale_lease.is_none());
    transaction.commit().await?;

    let transaction = client.transaction().await?;
    let fresh_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&fresh_runtime_id),
        120,
        false,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease grouped spread job for plan runtime", error))?;
    let job = fresh_lease.expect("matching plan runtime should lease grouped spread job");
    assert_eq!(job.id, job_id);
    transaction.commit().await?;

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_yields_spread_group_to_unused_group_runtime() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping grouped runtime-spread fairness test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let parent_runtime_id = Uuid::new_v4();
    let group_runtime_id = Uuid::new_v4();
    let group_lease_id = Uuid::new_v4();
    let group_id = Uuid::new_v4();
    let completed_job_id = Uuid::new_v4();
    let queued_job_id = Uuid::new_v4();
    let spread_payload = PgJson(json!({
        "prompt_text": "spread-safe sibling",
        "metadata": {
            "writeScope": { "mode": "owned", "ownedPaths": ["handoff/fairness/a.txt"] },
            "runtimeRouting": {
                "strategy": "spread",
                "allowUntargetedAcrossPreferredRuntimes": true
            },
            "multiAgentPlan": {
                "groupId": group_id,
                "parentRuntimeId": parent_runtime_id
            }
        }
    }));

    client
        .execute(
            "INSERT INTO runtime_leases (id, metadata, released_at)
             VALUES ($1, $2, NULL)",
            &[&group_lease_id, &PgJson(json!({ "groupId": group_id }))],
        )
        .await?;
    client
        .execute(
            "INSERT INTO runtimes (id, project_id, status, active_lease_id)
             VALUES ($1, $2, 'ready', $3)",
            &[&group_runtime_id, &project_id, &group_lease_id],
        )
        .await?;
    client
        .execute(
            "INSERT INTO agent_jobs (
                 id,
                 project_id,
                 conversation_id,
                 status,
                 payload,
                 priority,
                 leased_by_runtime_id,
                 target_runtime_id
             )
             VALUES ($1, $2, NULL, 'completed', $3, 10, $4, $4),
                    ($5, $2, NULL, 'queued', $3, 10, NULL, $4)",
            &[
                &completed_job_id,
                &project_id,
                &spread_payload,
                &parent_runtime_id,
                &queued_job_id,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let parent_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&parent_runtime_id),
        120,
        false,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease spread job for already-used parent", error))?;
    assert!(parent_lease.is_none());
    transaction.commit().await?;

    let transaction = client.transaction().await?;
    let group_lease = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&group_runtime_id),
        120,
        false,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease spread job for unused group runtime", error))?;
    let job = group_lease.expect("unused group runtime should receive the next spread sibling");
    assert_eq!(job.id, queued_job_id);
    transaction.commit().await?;

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_batches_exact_write_scoped_siblings() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping exact write-scoped batch test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let group_id = Uuid::new_v4().to_string();
    let alpha_job_id = Uuid::new_v4();
    let glob_job_id = Uuid::new_v4();
    let bravo_job_id = Uuid::new_v4();
    let payload_for_path = |handle: &str, owned_path: serde_json::Value| {
        PgJson(json!({
            "prompt_text": format!("write {handle}"),
            "metadata": {
                "agent": {
                    "handle": handle
                },
                "multiAgentPlan": {
                    "role": "worker",
                    "groupId": group_id.clone()
                },
                "runtimeRouting": {
                    "strategy": "reuse"
                },
                "writeScope": {
                    "mode": "owned",
                    "ownedPaths": owned_path
                }
            }
        }))
    };
    let alpha_payload = payload_for_path("alpha", json!(["tmp/batch/alpha.txt"]));
    let glob_payload = payload_for_path("glob", json!(["tmp/batch/**"]));
    let bravo_payload = payload_for_path("bravo", json!(["tmp/batch/bravo.txt"]));

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority)
             VALUES ($1, $2, NULL, 'queued', $3, 10),
                    ($4, $2, NULL, 'queued', $5, 20),
                    ($6, $2, NULL, 'queued', $7, 30)",
            &[
                &alpha_job_id,
                &project_id,
                &alpha_payload,
                &glob_job_id,
                &glob_payload,
                &bravo_job_id,
                &bravo_payload,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let first = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        true,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease first exact write job", error))?;
    let first_job = first.expect("first exact write-scoped job should lease");
    assert_eq!(first_job.id, alpha_job_id);

    let second = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        true,
        false,
        true,
        true,
        None,
        Some(group_id.as_str()),
    )
    .await
    .map_err(|error| controller_error("lease second exact write job", error))?;
    let second_job = second.expect("second exact write-scoped job should lease");
    assert_eq!(second_job.id, bravo_job_id);
    transaction.commit().await?;

    let glob_status: String = client
        .query_one(
            "SELECT status FROM agent_jobs WHERE id = $1",
            &[&glob_job_id],
        )
        .await?
        .get(0);
    assert_eq!(glob_status, "queued");

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_excludes_runtime_spread_jobs_from_secondary_batch_slots(
) -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping runtime-spread batch exclusion test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let spread_job_id = Uuid::new_v4();
    let spread_payload = PgJson(json!({
        "prompt_text": "spread-safe sibling",
        "metadata": {
            "writeScope": { "mode": "read_only" },
            "runtimeRouting": {
                "strategy": "spread"
            }
        }
    }));

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority)
             VALUES ($1, $2, NULL, 'queued', $3, 10)",
            &[&spread_job_id, &project_id, &spread_payload],
        )
        .await?;

    let transaction = client.transaction().await?;
    let leased = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        true,
        true,
        false,
        true,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease spread secondary job", error))?;
    assert!(leased.is_none());
    transaction.commit().await?;

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn lease_next_agent_job_skips_runtime_spread_when_runtime_is_busy() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping runtime-spread busy-runtime test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                target_runtime_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;
    create_runtime_spread_scope_tables(&client).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let busy_job_id = Uuid::new_v4();
    let spread_job_id = Uuid::new_v4();
    let busy_payload = PgJson(json!({
        "prompt_text": "already running",
        "metadata": {}
    }));
    let spread_payload = PgJson(json!({
        "prompt_text": "spread-safe sibling",
        "metadata": {
            "writeScope": { "mode": "read_only" },
            "runtimeRouting": {
                "strategy": "spread",
                "allowUntargetedAcrossPreferredRuntimes": true
            }
        }
    }));

    client
        .execute(
            "INSERT INTO agent_jobs (
                 id,
                 project_id,
                 conversation_id,
                 status,
                 payload,
                 priority,
                 leased_by_runtime_id,
                 lease_expires_at
             )
             VALUES ($1, $2, NULL, 'leased', $3, 10, $4, now() + interval '60 seconds'),
                    ($5, $2, NULL, 'queued', $6, 20, NULL, NULL)",
            &[
                &busy_job_id,
                &project_id,
                &busy_payload,
                &runtime_id,
                &spread_job_id,
                &spread_payload,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let leased = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        120,
        false,
        false,
        false,
        false,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lease spread job for busy runtime", error))?;
    assert!(leased.is_none());
    transaction.commit().await?;

    let spread_status: String = client
        .query_one(
            "SELECT status FROM agent_jobs WHERE id = $1",
            &[&spread_job_id],
        )
        .await?
        .get(0);
    assert_eq!(spread_status, "queued");

    connection_handle.abort();

    Ok(())
}

#[tokio::test]
async fn resolve_origin_for_protocol_prefers_online_presence() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origins test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let origin_a = Uuid::new_v4();
    let origin_b = Uuid::new_v4();

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols, region)
                 VALUES ($1, $2, 'desktop', 'https://desktop-origin', ARRAY['webdav']::text[], 'iad')",
                &[&origin_a, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols, region)
                 VALUES ($1, $2, 'efs', 'https://gateway-origin', ARRAY['webdav']::text[], 'iad')",
                &[&origin_b, &project_id],
            )
            .await?;
    }

    record_presence_heartbeat(
        &pool,
        &origin_b,
        &project_id,
        OriginPresenceStatus::Offline,
        Some(250),
        Some("iad"),
        None,
    )
    .await?;

    record_presence_heartbeat(
        &pool,
        &origin_a,
        &project_id,
        OriginPresenceStatus::Online,
        Some(45),
        Some("iad"),
        None,
    )
    .await?;

    let resolved = resolve_origin_for_protocol(&pool, &project_id, "webdav").await?;
    assert!(resolved.is_some());
    let resolved = resolved.unwrap();
    assert_eq!(resolved.origin.id, origin_a);
    assert!(matches!(
        resolved
            .presence
            .expect("presence expected for resolved origin")
            .status,
        OriginPresenceStatus::Online
    ));

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn resolve_origin_for_protocol_skips_offline_presence() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origins test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols, region)
                 VALUES ($1, $2, 'desktop', 'https://desktop-origin', ARRAY['http']::text[], 'iad')",
                &[&origin_id, &project_id],
            )
            .await?;
    }

    record_presence_heartbeat(
        &pool,
        &origin_id,
        &project_id,
        OriginPresenceStatus::Offline,
        Some(100),
        Some("iad"),
        None,
    )
    .await?;

    let unresolved = resolve_origin_for_protocol(&pool, &project_id, "http").await?;
    assert!(unresolved.is_none(), "offline origins should not resolve");

    record_presence_heartbeat(
        &pool,
        &origin_id,
        &project_id,
        OriginPresenceStatus::Online,
        Some(40),
        Some("iad"),
        None,
    )
    .await?;

    let resolved = resolve_origin_for_protocol(&pool, &project_id, "http").await?;
    assert!(resolved.is_some());
    assert_eq!(resolved.unwrap().origin.id, origin_id);

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn post_origin_register_upserts_origin() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origin register test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    use axum::http::{HeaderMap, HeaderValue};

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    // Candidate-less private origins are bound to the controller-issued,
    // signed runtime identity; callers may not select a separate origin UUID.
    let origin_id = runtime_id;
    let owner_user_id = Uuid::new_v4();
    let capabilities = json!({
        "_instafySelfHostedAccess": {
            "mode": "private",
            "ownerUserId": owner_user_id.to_string(),
        }
    });

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, capabilities
                 ) VALUES ($1, $2, 'self-hosted', 'ready', 600, now(), $3)",
                &[&runtime_id, &project_id, &PgJson(capabilities)],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);

    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let request = OriginRegisterBody {
        project_id: project_id.to_string(),
        origin_id: origin_id.to_string(),
        mode: Some("desktop".to_string()),
        endpoint: "http://127.0.0.1:54332".to_string(),
        protocols: Some(vec!["HTTP".to_string(), "apply".to_string()]),
        region: Some("us-east-1".to_string()),
        device_id: Some("device-123".to_string()),
        metadata: Some(json!({ "source": "test" })),
    };

    let headers = HeaderMap::new();
    // Missing auth should fail.
    let unauthorized = post_origin_register(
        axum::extract::State(state.clone()),
        headers.clone(),
        AxumJson(request.clone()),
    )
    .await;
    assert!(unauthorized.is_err());

    let scopes = vec!["origin.register", "origin.presence", "origin.apply"];
    let unbound_token = mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: owner_user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: None,
            protocol: None,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
    .expect("mint unbound origin token");
    let mut unbound_headers = HeaderMap::new();
    unbound_headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", unbound_token.token)).unwrap(),
    );
    let unbound = post_origin_register(
        axum::extract::State(state.clone()),
        unbound_headers,
        AxumJson(request.clone()),
    )
    .await
    .expect_err("runtime-less origin mutation token must be rejected");
    assert_eq!(unbound.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        unbound.1.message,
        "origin mutation token is missing its runtime scope"
    );

    // Provide a live runtime-bound bearer token.
    let token = mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: owner_user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
    .expect("mint origin token");

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token.token)).unwrap(),
    );

    let response = post_origin_register(
        axum::extract::State(state.clone()),
        headers,
        AxumJson(request),
    )
    .await
    .expect("origin register response");

    assert_eq!(response.origin_id, origin_id);
    assert_eq!(response.project_id, project_id);
    assert_eq!(response.mode, "desktop");
    assert_eq!(response.endpoint, "http://127.0.0.1:54332");
    assert_eq!(response.protocols, vec!["apply", "http"]);
    assert_eq!(response.region.as_deref(), Some("us-east-1"));
    assert_eq!(response.device_id.as_deref(), Some("device-123"));

    let stored = {
        let connection = pool.get().await?;
        connection
            .query_one(
                "SELECT endpoint, protocols, region, device_id FROM workspace_origins WHERE id = $1",
                &[&origin_id],
            )
            .await?
    };

    let stored_endpoint: String = stored.get("endpoint");
    let stored_protocols: Vec<String> = stored.get("protocols");
    let stored_region: Option<String> = stored.get("region");
    let stored_device_id: Option<String> = stored.get("device_id");

    assert_eq!(stored_endpoint, "http://127.0.0.1:54332");
    assert_eq!(stored_protocols, vec!["apply", "http"]);
    assert_eq!(stored_region.as_deref(), Some("us-east-1"));
    assert_eq!(stored_device_id.as_deref(), Some("device-123"));

    let binding = {
        let connection = pool.get().await?;
        connection
            .query_one(
                "SELECT runtime_id, origin_id, status
                 FROM origin_instances
                 WHERE id = $1",
                &[&origin_id],
            )
            .await?
    };
    assert_eq!(
        binding.get::<_, Option<Uuid>>("runtime_id"),
        Some(runtime_id)
    );
    assert_eq!(binding.get::<_, Option<Uuid>>("origin_id"), Some(origin_id));
    assert_eq!(binding.get::<_, String>("status"), "online");

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn workspace_origin_id_is_project_immutable() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping workspace origin identity test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let first_project_id = Uuid::new_v4();
    let second_project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active'), ($2, 'customer', 'active')",
                &[&first_project_id, &second_project_id],
            )
            .await?;
    }

    crate::origins::upsert_workspace_origin(
        &pool,
        &origin_id,
        &first_project_id,
        crate::origins::OriginMode::Desktop,
        "https://first-project-origin",
        &["http".to_string()],
        None,
        None,
        None,
    )
    .await?;
    let moved = crate::origins::upsert_workspace_origin(
        &pool,
        &origin_id,
        &second_project_id,
        crate::origins::OriginMode::Desktop,
        "https://second-project-attacker",
        &["http".to_string()],
        None,
        None,
        None,
    )
    .await
    .expect_err("workspace origin primary key must not move between projects");
    assert!(moved
        .to_string()
        .contains("workspace origin id belongs to another project"));

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "select project_id, endpoint from workspace_origins where id = $1",
                &[&origin_id],
            )
            .await?;
        assert_eq!(row.get::<_, Uuid>("project_id"), first_project_id);
        assert_eq!(
            row.get::<_, String>("endpoint"),
            "https://first-project-origin"
        );
    }

    cleanup_origin_project(&pool, &first_project_id).await?;
    cleanup_origin_project(&pool, &second_project_id).await?;
    Ok(())
}

#[tokio::test]
async fn workspace_origin_id_cannot_be_reassigned_between_projects() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping immutable origin ownership test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let project_a = Uuid::new_v4();
    let project_b = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active'), ($2, 'customer', 'active')",
                &[&project_a, &project_b],
            )
            .await?;
    }

    upsert_workspace_origin(
        &pool,
        &origin_id,
        &project_a,
        OriginMode::Desktop,
        "https://origin-a.example",
        &["http".to_string()],
        None,
        None,
        None,
    )
    .await?;
    let reassignment = upsert_workspace_origin(
        &pool,
        &origin_id,
        &project_b,
        OriginMode::Desktop,
        "https://origin-b.example",
        &["http".to_string()],
        None,
        None,
        None,
    )
    .await;
    assert!(reassignment.is_err());

    let stored_project: Uuid = pool
        .get()
        .await?
        .query_one(
            "select project_id from workspace_origins where id = $1",
            &[&origin_id],
        )
        .await?
        .get("project_id");
    assert_eq!(stored_project, project_a);

    cleanup_origin_project(&pool, &project_a).await?;
    cleanup_origin_project(&pool, &project_b).await?;
    Ok(())
}

#[tokio::test]
async fn post_origin_register_updates_origin_instance_state() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origin register test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    use axum::http::{HeaderMap, HeaderValue};

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at
                 ) VALUES ($1, $2, 'instafy-cloud', 'ready', 600, now())",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now(), now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
        let protocols: Vec<String> = vec!["http".to_string()];
        connection
            .execute(
                "INSERT INTO origin_instances (id, project_id, runtime_id, lease_id, required, mode, status, protocols, metadata)
                 VALUES ($1, $2, $3, $4, true, 'hosted', 'requested', $5::text[], '{}'::jsonb)",
                &[&origin_id, &project_id, &runtime_id, &lease_id, &protocols],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);
    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let token = mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: "runtime.service".to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: vec!["origin.register".to_string()],
            lease_id: Some(lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
    .expect("mint origin register token");

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token.token)).unwrap(),
    );

    let request = OriginRegisterBody {
        project_id: project_id.to_string(),
        origin_id: origin_id.to_string(),
        mode: Some("hosted".to_string()),
        endpoint: "http://127.0.0.1:54332".to_string(),
        protocols: Some(vec!["HTTP".to_string()]),
        region: None,
        device_id: None,
        metadata: None,
    };

    let _response = post_origin_register(
        axum::extract::State(state.clone()),
        headers,
        AxumJson(request),
    )
    .await
    .expect("origin register response");

    let row = {
        let connection = pool.get().await?;
        connection
            .query_one(
                "SELECT status, endpoint, origin_id, protocols
                 FROM origin_instances
                 WHERE id = $1",
                &[&origin_id],
            )
            .await?
    };

    let status: String = row.get("status");
    let endpoint: Option<String> = row.get("endpoint");
    let stored_origin_id: Option<Uuid> = row.get("origin_id");
    let stored_protocols: Vec<String> = row.get("protocols");

    assert_eq!(status, "online");
    assert_eq!(endpoint.as_deref(), Some("http://127.0.0.1:54332"));
    assert_eq!(stored_origin_id, Some(origin_id));
    assert_eq!(stored_protocols, vec!["http".to_string()]);

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

// Superseded contract: this test asserts the pre-collaboration desktop
// origin-register flow (arbitrary origin_id != runtime_id, subject "origin.test",
// 401 on a second UUID). origin/main's shipped shared-browser hardening rebound
// origin-register to origin_id == runtime_id + controller-attested owner subjects
// + active-lease binding, and returns 403 on rebinding. The new contract is
// covered by post_origin_register_upserts_origin; this test needs the
// shared-browser author to reconcile the desktop-instance-claim path against it.
#[ignore = "superseded desktop origin-register contract; reconcile with origin/main shared-browser hardening"]
#[tokio::test]
async fn post_origin_register_claims_unassigned_desktop_instance_once() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origin register test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    use axum::http::{HeaderMap, HeaderValue};

    let project_id = Uuid::new_v4();
    let assignment_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let tunnel_grant_id = Uuid::new_v4();
    let tunnel_endpoint = format!("https://origin-{runtime_id}.example.test");
    let tunnel_hostname = format!("origin-{runtime_id}.example.test");

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 VALUES ($1, $2, 'runtime', 'ready', 600, now())",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now(), now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO origin_instances
                   (id, project_id, runtime_id, lease_id, required, mode, status, protocols, metadata)
                 VALUES ($1, $2, $3, $4, true, 'desktop', 'requested',
                         ARRAY['http']::text[], '{}'::jsonb)",
                &[&assignment_id, &project_id, &runtime_id, &lease_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_tunnel_grants
                   (id, project_id, runtime_id, runtime_lease_id, provider, tunnel_id,
                    hostname, url, status, expires_at, metadata)
                 VALUES ($1, $2, $3, $4, 'self_hosted', $5, $6, $7, 'active',
                         now() + interval '10 minutes', '{}'::jsonb)",
                &[
                    &tunnel_grant_id,
                    &project_id,
                    &runtime_id,
                    &lease_id,
                    &format!("test-{runtime_id}"),
                    &tunnel_hostname,
                    &tunnel_endpoint,
                ],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    config.dev_mode = false;
    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);
    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let token = mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: runtime_id.to_string(),
            subject: "origin.test".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: vec!["origin.register".to_string(), "origin.presence".to_string()],
            lease_id: Some(lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
    .expect("mint origin register token");

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token.token)).unwrap(),
    );

    let request = OriginRegisterBody {
        project_id: project_id.to_string(),
        origin_id: origin_id.to_string(),
        mode: Some("desktop".to_string()),
        endpoint: tunnel_endpoint.clone(),
        protocols: Some(vec!["HTTP".to_string()]),
        region: None,
        device_id: None,
        metadata: None,
    };

    let _response = post_origin_register(
        axum::extract::State(state.clone()),
        headers.clone(),
        AxumJson(request),
    )
    .await
    .expect("origin register response");

    let row = {
        let connection = pool.get().await?;
        connection
            .query_one(
                "SELECT status, endpoint, origin_id, protocols
                 FROM origin_instances
                 WHERE id = $1",
                &[&assignment_id],
            )
            .await?
    };

    let status: String = row.get("status");
    let endpoint: Option<String> = row.get("endpoint");
    let stored_origin_id: Option<Uuid> = row.get("origin_id");
    let stored_protocols: Vec<String> = row.get("protocols");

    assert_eq!(status, "online");
    assert_eq!(endpoint.as_deref(), Some(tunnel_endpoint.as_str()));
    assert_eq!(stored_origin_id, Some(origin_id));
    assert_eq!(stored_protocols, vec!["http".to_string()]);

    let presence = origins::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/origin/presence/beat"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::from(
                    json!({ "originId": origin_id, "status": "online" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(presence.status(), StatusCode::OK);

    let rejected_origin_id = Uuid::new_v4();
    let rejected = post_origin_register(
        axum::extract::State(state.clone()),
        headers,
        AxumJson(OriginRegisterBody {
            project_id: project_id.to_string(),
            origin_id: rejected_origin_id.to_string(),
            mode: Some("desktop".to_string()),
            endpoint: tunnel_endpoint,
            protocols: Some(vec!["http".to_string()]),
            region: None,
            device_id: None,
            metadata: None,
        }),
    )
    .await
    .expect_err("runtime assignment must reject a second origin UUID");
    assert_eq!(rejected.0, StatusCode::UNAUTHORIZED);

    let rejected_origin_count: i64 = pool
        .get()
        .await?
        .query_one(
            "select count(*) from workspace_origins where id = $1",
            &[&rejected_origin_id],
        )
        .await?
        .get(0);
    assert_eq!(rejected_origin_count, 0);

    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        runtime::release_origin_instances_for_runtime(&transaction, &runtime_id)
            .await
            .map_err(|error| controller_error("release runtime origin assignment", error))?;
        transaction.commit().await?;
    }
    let released_row = pool
        .get()
        .await?
        .query_one(
            "select status, origin_id from origin_instances where id = $1",
            &[&assignment_id],
        )
        .await?;
    assert_eq!(released_row.get::<_, String>("status"), "released");
    assert_eq!(
        released_row.get::<_, Option<Uuid>>("origin_id"),
        Some(origin_id)
    );

    let offline = origins::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/origin/presence/beat"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::from(
                    json!({ "originId": origin_id, "status": "offline" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(offline.status(), StatusCode::OK);

    let online_after_release = origins::router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/origin/presence/beat"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::from(
                    json!({ "originId": origin_id, "status": "online" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(online_after_release.status(), StatusCode::UNAUTHORIZED);

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn origin_registration_rejects_reserved_missing_and_hijacked_bindings() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origin registration boundary test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    use axum::http::{HeaderMap, HeaderValue};

    let project_id = Uuid::new_v4();
    let foreign_project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let private_runtime_id = Uuid::new_v4();
    let managed_runtime_id = Uuid::new_v4();
    let managed_lease_id = Uuid::new_v4();
    let missing_runtime_id = Uuid::new_v4();
    let missing_lease_id = Uuid::new_v4();
    let managed_origin_id = Uuid::new_v4();
    let managed_instance_id = Uuid::new_v4();
    let foreign_origin_id = Uuid::new_v4();
    let valid_private_origin_id = private_runtime_id;
    let missing_origin_id = Uuid::new_v4();
    let reserved_hosted_origin_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("instafy:hosted-origin:{project_id}").as_bytes(),
    );
    let future_foreign_hosted_origin_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("instafy:hosted-origin:{foreign_project_id}").as_bytes(),
    );
    let private_capabilities = PgJson(json!({
        "_instafySelfHostedAccess": {
            "mode": "private",
            "ownerUserId": owner_user_id.to_string(),
        }
    }));

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active'), ($2, 'customer', 'active')",
                &[&project_id, &foreign_project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, capabilities
                 ) values
                   ($1, $4, 'self-hosted', 'ready', 600, now(), $5),
                   ($2, $4, 'instafy-cloud', 'ready', 600, now(), '{}'::jsonb),
                   ($3, $4, 'instafy-cloud', 'ready', 600, now(), '{}'::jsonb)",
                &[
                    &private_runtime_id,
                    &managed_runtime_id,
                    &missing_runtime_id,
                    &project_id,
                    &private_capabilities,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) values
                   ($1, $3, $4, 'active', now(), now()),
                   ($2, $3, $5, 'active', now(), now())",
                &[
                    &managed_lease_id,
                    &missing_lease_id,
                    &project_id,
                    &managed_runtime_id,
                    &missing_runtime_id,
                ],
            )
            .await?;
        connection
            .execute(
                "update runtimes
                 set active_lease_id = case
                   when id = $1 then $3
                   when id = $2 then $4
                   else active_lease_id
                 end
                 where id in ($1, $2)",
                &[
                    &managed_runtime_id,
                    &missing_runtime_id,
                    &managed_lease_id,
                    &missing_lease_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into workspace_origins (
                     id, project_id, mode, endpoint, protocols
                 ) values
                   ($1, $3, 'hosted', 'https://trusted-managed-origin', ARRAY['http']::text[]),
                   ($2, $4, 'desktop', 'https://foreign-origin', ARRAY['http']::text[])",
                &[
                    &managed_origin_id,
                    &foreign_origin_id,
                    &project_id,
                    &foreign_project_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into origin_instances (
                     id, project_id, runtime_id, lease_id, origin_id, required,
                     mode, status, endpoint, protocols, metadata
                 ) values (
                     $1, $2, $3, $4, $5, true,
                     'hosted', 'online', 'https://trusted-managed-origin',
                     ARRAY['http']::text[], '{}'::jsonb
                 )",
                &[
                    &managed_instance_id,
                    &project_id,
                    &managed_runtime_id,
                    &managed_lease_id,
                    &managed_origin_id,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "origin-registration-boundaries",
    );
    let state = build_test_state(pool.clone(), config);
    let headers_for =
        |runtime_id: Uuid, lease_id: Option<Uuid>, subject: String, origin_id: Uuid| -> HeaderMap {
            let token = mint_scoped_token(
                &state.config,
                ScopedTokenRequest {
                    audience: project_id.to_string(),
                    subject,
                    project_id: project_id.to_string(),
                    origin_id: Some(origin_id.to_string()),
                    runtime_id: Some(runtime_id.to_string()),
                    protocol: None,
                    scopes: vec!["origin.register".to_string()],
                    lease_id: lease_id.map(|value| value.to_string()),
                    run_id: None,
                    prefer_runtime: None,
                    ttl_seconds: None,
                },
            )
            .expect("mint origin registration token");
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", token.token)).unwrap(),
            );
            headers
        };
    let request_for = |origin_id: Uuid, mode: &str, endpoint: &str| OriginRegisterBody {
        project_id: project_id.to_string(),
        origin_id: origin_id.to_string(),
        mode: Some(mode.to_string()),
        endpoint: endpoint.to_string(),
        protocols: Some(vec!["http".to_string()]),
        region: None,
        device_id: None,
        metadata: None,
    };

    let same_project_hijack = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(
            private_runtime_id,
            None,
            owner_user_id.to_string(),
            managed_origin_id,
        ),
        AxumJson(request_for(
            managed_origin_id,
            "desktop",
            "https://attacker-same-project",
        )),
    )
    .await
    .expect_err("private runtime must not hijack managed origin in the same project");
    assert_eq!(same_project_hijack.0, StatusCode::FORBIDDEN);

    let cross_project_hijack = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(
            private_runtime_id,
            None,
            owner_user_id.to_string(),
            foreign_origin_id,
        ),
        AxumJson(request_for(
            foreign_origin_id,
            "desktop",
            "https://attacker-cross-project",
        )),
    )
    .await
    .expect_err("private runtime must not move a foreign project's origin id");
    assert_eq!(cross_project_hijack.0, StatusCode::FORBIDDEN);

    let reserved = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(
            private_runtime_id,
            None,
            owner_user_id.to_string(),
            reserved_hosted_origin_id,
        ),
        AxumJson(request_for(
            reserved_hosted_origin_id,
            "desktop",
            "https://attacker-reserved",
        )),
    )
    .await
    .expect_err("runtime must not claim the stable hosted gateway id");
    assert_eq!(reserved.0, StatusCode::FORBIDDEN);

    let future_foreign_preclaim = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(
            private_runtime_id,
            None,
            owner_user_id.to_string(),
            future_foreign_hosted_origin_id,
        ),
        AxumJson(request_for(
            future_foreign_hosted_origin_id,
            "desktop",
            "https://attacker-future-foreign-hosted-origin",
        )),
    )
    .await
    .expect_err("private runtime must not preclaim another project's future hosted origin id");
    assert_eq!(future_foreign_preclaim.0, StatusCode::FORBIDDEN);

    let missing_instance = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(
            missing_runtime_id,
            Some(missing_lease_id),
            "runtime.service".to_string(),
            missing_origin_id,
        ),
        AxumJson(request_for(
            missing_origin_id,
            "hosted",
            "https://missing-instance",
        )),
    )
    .await
    .expect_err("managed runtime without a preallocated instance must fail closed");
    assert_eq!(missing_instance.0, StatusCode::FORBIDDEN);

    let registered = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(
            private_runtime_id,
            None,
            owner_user_id.to_string(),
            valid_private_origin_id,
        ),
        AxumJson(request_for(
            valid_private_origin_id,
            "desktop",
            "https://private-origin",
        )),
    )
    .await
    .expect("private self-hosted runtime may register its controller-bound runtime id");
    assert_eq!(registered.origin_id, valid_private_origin_id);

    {
        let connection = pool.get().await?;
        let endpoints = connection
            .query(
                "select id, project_id, endpoint
                 from workspace_origins
                 where id = any($1::uuid[])",
                &[&vec![managed_origin_id, foreign_origin_id]],
            )
            .await?;
        assert_eq!(endpoints.len(), 2);
        for row in endpoints {
            let id: Uuid = row.get("id");
            if id == managed_origin_id {
                assert_eq!(row.get::<_, Uuid>("project_id"), project_id);
                assert_eq!(
                    row.get::<_, String>("endpoint"),
                    "https://trusted-managed-origin"
                );
            } else {
                assert_eq!(id, foreign_origin_id);
                assert_eq!(row.get::<_, Uuid>("project_id"), foreign_project_id);
                assert_eq!(row.get::<_, String>("endpoint"), "https://foreign-origin");
            }
        }
        let reserved_count: i64 = connection
            .query_one(
                "select count(*) from workspace_origins where id = any($1::uuid[])",
                &[&vec![
                    reserved_hosted_origin_id,
                    future_foreign_hosted_origin_id,
                ]],
            )
            .await?
            .get(0);
        assert_eq!(reserved_count, 0);
        let private_binding = connection
            .query_one(
                "select runtime_id, origin_id, status
                 from origin_instances where id = $1",
                &[&valid_private_origin_id],
            )
            .await?;
        assert_eq!(
            private_binding.get::<_, Option<Uuid>>("runtime_id"),
            Some(private_runtime_id)
        );
        assert_eq!(
            private_binding.get::<_, Option<Uuid>>("origin_id"),
            Some(valid_private_origin_id)
        );
        assert_eq!(private_binding.get::<_, String>("status"), "online");
    }

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_origin_project(&pool, &foreign_project_id).await?;
    Ok(())
}

#[tokio::test]
async fn concurrent_private_origin_preclaim_attempts_are_rejected() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping concurrent origin claim test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    use axum::http::{HeaderMap, HeaderValue};

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let first_runtime_id = Uuid::new_v4();
    let second_runtime_id = Uuid::new_v4();
    let first_owner_id = Uuid::new_v4();
    let second_owner_id = Uuid::new_v4();
    let first_capabilities = PgJson(json!({
        "_instafySelfHostedAccess": {
            "mode": "private",
            "ownerUserId": first_owner_id.to_string(),
        }
    }));
    let second_capabilities = PgJson(json!({
        "_instafySelfHostedAccess": {
            "mode": "private",
            "ownerUserId": second_owner_id.to_string(),
        }
    }));
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, capabilities
                 ) values
                   ($1, $3, 'self-hosted', 'ready', 600, now(), $4),
                   ($2, $3, 'self-hosted', 'ready', 600, now(), $5)",
                &[
                    &first_runtime_id,
                    &second_runtime_id,
                    &project_id,
                    &first_capabilities,
                    &second_capabilities,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "concurrent-private-origin-claim",
    );
    let state = build_test_state(pool.clone(), config);
    let headers_for = |runtime_id: Uuid, owner_id: Uuid| -> HeaderMap {
        let token = mint_scoped_token(
            &state.config,
            ScopedTokenRequest {
                audience: project_id.to_string(),
                subject: owner_id.to_string(),
                project_id: project_id.to_string(),
                origin_id: Some(origin_id.to_string()),
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes: vec!["origin.register".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .expect("mint concurrent origin token");
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", token.token)).unwrap(),
        );
        headers
    };
    let request = OriginRegisterBody {
        project_id: project_id.to_string(),
        origin_id: origin_id.to_string(),
        mode: Some("desktop".to_string()),
        endpoint: "https://concurrent-origin".to_string(),
        protocols: Some(vec!["http".to_string()]),
        region: None,
        device_id: None,
        metadata: None,
    };

    let first = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(first_runtime_id, first_owner_id),
        AxumJson(request.clone()),
    );
    let second = post_origin_register(
        axum::extract::State(state.clone()),
        headers_for(second_runtime_id, second_owner_id),
        AxumJson(request),
    );
    let (first, second) = tokio::join!(first, second);
    assert_eq!(
        first
            .expect_err("first arbitrary private origin preclaim must fail")
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        second
            .expect_err("second arbitrary private origin preclaim must fail")
            .0,
        StatusCode::FORBIDDEN
    );

    {
        let connection = pool.get().await?;
        let workspace_count: i64 = connection
            .query_one(
                "select count(*) from workspace_origins where id = $1 and project_id = $2",
                &[&origin_id, &project_id],
            )
            .await?
            .get(0);
        let binding_count: i64 = connection
            .query_one(
                "select count(*) from origin_instances
                 where origin_id = $1 and project_id = $2 and status = 'online'",
                &[&origin_id, &project_id],
            )
            .await?
            .get(0);
        assert_eq!(workspace_count, 0);
        assert_eq!(binding_count, 0);
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn unattested_custom_self_hosted_runtime_is_quarantined_across_access_boundaries(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping custom self-hosted quarantine test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let provider_id = format!("custom-local-{runtime_id}");
    ensure_test_user(&pool, &owner_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Custom self-hosted quarantine')",
                &[&org_id, &format!("custom-self-hosted-quarantine-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner')",
                &[&org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $2, $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, capabilities,
                     idle_ttl_seconds, last_seen_at
                 ) values ($1, $2, $3, 'ready', '{}'::jsonb, 600, now())",
                &[&runtime_id, &project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_events (runtime_id, project_id, kind, data)
                 values ($1, $2, 'runtime.private_diagnostic', '{\"secret\":true}'::jsonb)",
                &[&runtime_id, &project_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "custom-self-hosted-quarantine",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: provider_id.clone(),
        display_name: "Custom local provider".to_string(),
        kind: "self_hosted".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue custom runtime owner token", error))?
        .token;
    let mut state = build_test_state(pool.clone(), config);
    state.tunnel_broker = Some(Arc::new(StubTunnelBroker::default()));
    assert!(crate::runtime::runtime_is_private_self_hosted(
        &state,
        &provider_id,
        &json!({}),
    ));
    state
        .provider_registry
        .replace(HashMap::new(), "instafy-cloud".to_string());
    assert!(
        crate::runtime::runtime_is_private_self_hosted(&state, &provider_id, &json!({})),
        "removing provider configuration must leave stale runtime rows quarantined"
    );

    let runtime_app = crate::runtime::router().with_state(state.clone());
    let status_response = runtime_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/runtime/status"))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(status_response.status(), StatusCode::OK);
    let status_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(status_response.into_body(), usize::MAX).await?)?;
    assert_eq!(status_payload["runtimes"], json!([]));

    let logs_response = runtime_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/runtime/logs"))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(logs_response.status(), StatusCode::OK);
    let logs_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(logs_response.into_body(), usize::MAX).await?)?;
    assert_eq!(logs_payload, json!([]));

    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let dispatch_error = dispatch::ensure_runtime_target_owner(
        &state,
        &transaction,
        &project_id,
        Some(runtime_id),
        Some(owner_user_id),
        false,
        false,
    )
    .await
    .expect_err("unattested custom runtime must not be a dispatch target");
    assert_eq!(dispatch_error.0, StatusCode::FORBIDDEN);
    dispatch::ensure_runtime_target_owner(
        &state,
        &transaction,
        &project_id,
        Some(runtime_id),
        None,
        true,
        false,
    )
    .await
    .expect("service-role cleanup must retain access to an orphaned runtime");
    transaction.rollback().await?;

    let origins_app = crate::origins::router().with_state(state.clone());
    let lease_response = origins_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/acquire")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "runtimeId": runtime_id,
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(lease_response.status(), StatusCode::FORBIDDEN);

    let tunnel_app = tunnels::router().with_state(state);
    let tunnel_response = tunnel_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/tunnels/request"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::from(json!({ "runtimeId": runtime_id }).to_string()))?,
        )
        .await?;
    assert_eq!(tunnel_response.status(), StatusCode::FORBIDDEN);

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn lease_routes_keep_private_self_hosted_bindings_owner_only() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private self-hosted lease route test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let collaborator_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &collaborator_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Private runtime lease boundary')",
                &[&org_id, &format!("private-runtime-lease-boundary-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder')",
                &[&org_id, &owner_user_id, &collaborator_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $2, $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, capabilities)
                 values ($1, $2, 'self-hosted', 'ready', $3)",
                &[
                    &runtime_id,
                    &project_id,
                    &PgJson(json!({
                        "_instafySelfHostedAccess": {
                            "mode": "private",
                            "ownerUserId": owner_user_id.to_string(),
                        }
                    })),
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "private-runtime-lease-boundary",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue private runtime owner token", error))?
        .token;
    let collaborator_token = crate::auth::issue_controller_token(&config, &collaborator_user_id)
        .map_err(|error| controller_error("issue private runtime collaborator token", error))?
        .token;
    let app = crate::origins::router().with_state(build_test_state(pool.clone(), config.clone()));

    let denied_acquire = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/acquire")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {collaborator_token}"))
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "runtimeId": runtime_id,
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(denied_acquire.status(), StatusCode::FORBIDDEN);

    // Model a pre-enforcement lease so renew/release and read redaction are
    // exercised against the canonical stored binding, not just request data.
    let lease = match acquire_lease(
        &pool,
        &project_id,
        Some(&collaborator_user_id),
        Some(&runtime_id),
        90,
        None,
    )
    .await?
    {
        LeaseAcquireOutcome::Granted(lease) => lease,
        other => panic!("expected legacy private runtime lease, got {other:?}"),
    };

    let collaborator_read = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header("authorization", format!("Bearer {collaborator_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(collaborator_read.status(), StatusCode::OK);
    let collaborator_read: serde_json::Value =
        serde_json::from_slice(&to_bytes(collaborator_read.into_body(), usize::MAX).await?)?;
    assert_eq!(
        collaborator_read["lease"]["userId"],
        collaborator_user_id.to_string()
    );
    assert!(collaborator_read["lease"]["runtimeId"].is_null());

    let owner_read = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(owner_read.status(), StatusCode::OK);
    let owner_read: serde_json::Value =
        serde_json::from_slice(&to_bytes(owner_read.into_body(), usize::MAX).await?)?;
    assert_eq!(owner_read["lease"]["runtimeId"], runtime_id.to_string());

    let collaborator_origin_token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: Uuid::new_v4().to_string(),
            subject: collaborator_user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(Uuid::new_v4().to_string()),
            runtime_id: Some(runtime_id.to_string()),
            protocol: Some("webdav".to_string()),
            scopes: vec!["fs.write".to_string()],
            lease_id: Some(lease.id.to_string()),
            run_id: None,
            prefer_runtime: Some(runtime_id.to_string()),
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint mismatched private runtime origin token", error))?
    .token;
    let denied_origin_token = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header(
                    "authorization",
                    format!("Bearer {collaborator_origin_token}"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied_origin_token.status(), StatusCode::UNAUTHORIZED);
    let denied_origin_token: serde_json::Value =
        serde_json::from_slice(&to_bytes(denied_origin_token.into_body(), usize::MAX).await?)?;
    assert_eq!(
        denied_origin_token["message"],
        "origin token subject does not own the private self-hosted runtime"
    );

    for (path, body) in [
        (
            "/lease/renew",
            json!({
                "leaseId": lease.id,
                "projectId": project_id,
                "runtimeId": runtime_id,
            }),
        ),
        (
            "/lease/release",
            json!({
                "leaseId": lease.id,
                "projectId": project_id,
                "runtimeId": runtime_id,
            }),
        ),
    ] {
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {collaborator_token}"))
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN, "{path}");
    }

    // A managed-cloud runtime does not carry the private owner boundary. The
    // same canonical lease remains visible and mutable by its project writer.
    pool.get()
        .await?
        .execute(
            "update runtimes
             set provider = 'instafy-cloud', capabilities = '{}'::jsonb
             where id = $1",
            &[&runtime_id],
        )
        .await?;

    let managed_read = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/lease"))
                .header("authorization", format!("Bearer {collaborator_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(managed_read.status(), StatusCode::OK);
    let managed_read: serde_json::Value =
        serde_json::from_slice(&to_bytes(managed_read.into_body(), usize::MAX).await?)?;
    assert_eq!(managed_read["lease"]["runtimeId"], runtime_id.to_string());

    let managed_renew = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/renew")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {collaborator_token}"))
                .body(Body::from(
                    json!({
                        "leaseId": lease.id,
                        "projectId": project_id,
                        "runtimeId": runtime_id,
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(managed_renew.status(), StatusCode::OK);

    let managed_release = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/lease/release")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {collaborator_token}"))
                .body(Body::from(
                    json!({
                        "leaseId": lease.id,
                        "projectId": project_id,
                        "runtimeId": runtime_id,
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(managed_release.status(), StatusCode::OK);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &collaborator_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn acquire_lease_allows_holder_and_blocks_competitors() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origins lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let other_project_id = Uuid::new_v4();
    let user_a = Uuid::new_v4();
    let user_b = Uuid::new_v4();

    ensure_test_user(&pool, &user_a).await?;
    ensure_test_user(&pool, &user_b).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status)
                 VALUES ($1, 'customer', 'active'), ($2, 'customer', 'active')",
                &[&project_id, &other_project_id],
            )
            .await?;
    }

    let first = acquire_lease(&pool, &project_id, Some(&user_a), None, 60, None).await?;
    let lease = match first {
        LeaseAcquireOutcome::Granted(record) => record,
        other => panic!("expected granted lease, got {other:?}"),
    };
    assert_eq!(lease.user_id, Some(user_a));

    let renewal = acquire_lease(&pool, &project_id, Some(&user_a), None, 90, None).await?;
    assert!(matches!(renewal, LeaseAcquireOutcome::Renewed(_)));

    let fresh_same_user =
        acquire_fresh_lease(&pool, &project_id, Some(&user_a), None, 300, None).await?;
    match fresh_same_user {
        LeaseAcquireOutcome::Conflict { holder } => {
            assert_eq!(holder.id, lease.id);
            assert_eq!(holder.user_id, Some(user_a));
        }
        other => panic!("expected fresh acquisition to preserve the active lease, got {other:?}"),
    }

    // A fresh one-shot mutation must remain exclusive even when an ordinary
    // acquisition arrives later with the same user/runtime identity. The
    // caller may still renew the exact lease id while the mutation is active.
    let fresh_first =
        acquire_fresh_lease(&pool, &other_project_id, Some(&user_a), None, 300, None).await?;
    let fresh_first = match fresh_first {
        LeaseAcquireOutcome::Granted(record) => record,
        other => panic!("expected fresh lease grant, got {other:?}"),
    };
    assert_eq!(
        fresh_first
            .metadata
            .as_ref()
            .and_then(|value| value.get("_instafyLeasePolicy"))
            .and_then(|value| value.get("allowImplicitRenewal"))
            .and_then(serde_json::Value::as_bool),
        Some(false)
    );
    let implicit_same_holder =
        acquire_lease(&pool, &other_project_id, Some(&user_a), None, 60, None).await?;
    match implicit_same_holder {
        LeaseAcquireOutcome::Conflict { holder } => {
            assert_eq!(holder.id, fresh_first.id);
            assert_eq!(holder.user_id, Some(user_a));
        }
        other => panic!("expected fresh lease to reject implicit adoption, got {other:?}"),
    }
    let exact_renewal = renew_long_lease(
        &pool,
        &fresh_first.id,
        &other_project_id,
        Some(&user_a),
        None,
        300,
        Some(&json!({ "heartbeat": true })),
    )
    .await?;
    let exact_renewal = exact_renewal.expect("exact-id renewal should remain valid");
    assert_eq!(exact_renewal.id, fresh_first.id);
    assert_eq!(
        exact_renewal
            .metadata
            .as_ref()
            .and_then(|value| value.get("_instafyLeasePolicy"))
            .and_then(|value| value.get("allowImplicitRenewal"))
            .and_then(serde_json::Value::as_bool),
        Some(false)
    );
    assert_eq!(
        exact_renewal
            .metadata
            .as_ref()
            .and_then(|value| value.get("heartbeat"))
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
    let after_exact_renewal =
        acquire_lease(&pool, &other_project_id, Some(&user_a), None, 60, None).await?;
    assert!(matches!(
        after_exact_renewal,
        LeaseAcquireOutcome::Conflict { holder } if holder.id == fresh_first.id
    ));

    let conflict = acquire_lease(&pool, &project_id, Some(&user_b), None, 60, None).await?;
    match conflict {
        LeaseAcquireOutcome::Conflict { holder } => {
            assert_eq!(holder.user_id, Some(user_a));
        }
        other => panic!("expected conflict outcome, got {other:?}"),
    }

    let cross_project_renewal = renew_lease(
        &pool,
        &lease.id,
        &other_project_id,
        Some(&user_a),
        None,
        60,
        None,
    )
    .await?;
    assert!(cross_project_renewal.is_none());
    let cross_project_release = release_lease(
        &pool,
        &lease.id,
        &other_project_id,
        Some(&user_a),
        None,
        "released",
    )
    .await?;
    assert!(cross_project_release.is_none());

    release_lease(
        &pool,
        &fresh_first.id,
        &other_project_id,
        Some(&user_a),
        None,
        "released",
    )
    .await?
    .expect("fresh lease should release by exact holder");

    let released = release_lease(
        &pool,
        &lease.id,
        &project_id,
        Some(&user_a),
        None,
        "released",
    )
    .await?
    .expect("released lease should exist");
    assert_eq!(released.status, "released");

    let takeover = acquire_lease(&pool, &project_id, Some(&user_b), None, 60, None).await?;
    let takeover = match takeover {
        LeaseAcquireOutcome::Granted(record) => {
            assert_eq!(record.user_id, Some(user_b));
            record
        }
        other => panic!("expected granted lease after release, got {other:?}"),
    };
    release_lease(
        &pool,
        &takeover.id,
        &project_id,
        Some(&user_b),
        None,
        "released",
    )
    .await?
    .expect("takeover lease should release");

    let runtime_a = Uuid::new_v4();
    let runtime_b = Uuid::new_v4();
    let device_a = acquire_lease(
        &pool,
        &project_id,
        Some(&user_a),
        Some(&runtime_a),
        60,
        None,
    )
    .await?;
    let device_a = match device_a {
        LeaseAcquireOutcome::Granted(record) => record,
        other => panic!("expected first device lease, got {other:?}"),
    };
    let same_user_other_device = acquire_lease(
        &pool,
        &project_id,
        Some(&user_a),
        Some(&runtime_b),
        60,
        None,
    )
    .await?;
    match same_user_other_device {
        LeaseAcquireOutcome::Conflict { holder } => {
            assert_eq!(holder.id, device_a.id);
            assert_eq!(holder.runtime_id, Some(runtime_a));
        }
        other => panic!("expected same-user device conflict, got {other:?}"),
    }

    release_lease(
        &pool,
        &device_a.id,
        &project_id,
        Some(&user_a),
        Some(&runtime_a),
        "released",
    )
    .await?
    .expect("first device lease should release");

    // The first-writer case used to be raceable because a FOR UPDATE query on
    // an empty workspace_leases set locks no row. Exercise two simultaneous
    // first acquisitions and assert that the project-row fence admits exactly
    // one active writer.
    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let mut attempts = Vec::new();
    for (user_id, runtime_id) in [(user_a, runtime_a), (user_b, runtime_b)] {
        let pool = pool.clone();
        let barrier = barrier.clone();
        attempts.push(tokio::spawn(async move {
            barrier.wait().await;
            acquire_lease(
                &pool,
                &project_id,
                Some(&user_id),
                Some(&runtime_id),
                60,
                None,
            )
            .await
        }));
    }
    barrier.wait().await;

    let mut granted = 0;
    let mut conflicted = 0;
    for attempt in attempts {
        match attempt.await.expect("lease acquisition task")? {
            LeaseAcquireOutcome::Granted(_) => granted += 1,
            LeaseAcquireOutcome::Conflict { .. } => conflicted += 1,
            other => panic!("unexpected concurrent lease outcome: {other:?}"),
        }
    }
    assert_eq!(granted, 1);
    assert_eq!(conflicted, 1);

    let active_count: i64 = {
        let connection = pool.get().await?;
        connection
            .query_one(
                "select count(*)::bigint
                 from workspace_leases
                 where project_id = $1
                   and status = 'active'
                   and expires_at > now()",
                &[&project_id],
            )
            .await?
            .get(0)
    };
    assert_eq!(active_count, 1);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_origin_project(&pool, &other_project_id).await?;

    Ok(())
}

#[tokio::test]
async fn renew_lease_allows_omitted_runtime_but_rejects_wrong_owners() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping origins lease renewal test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let other_runtime_id = Uuid::new_v4();

    ensure_test_user(&pool, &user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let lease = match acquire_fresh_lease(
        &pool,
        &project_id,
        Some(&user_id),
        Some(&runtime_id),
        300,
        None,
    )
    .await?
    {
        LeaseAcquireOutcome::Granted(record) => record,
        other => panic!("expected granted lease, got {other:?}"),
    };

    let wrong_user = renew_long_lease(
        &pool,
        &lease.id,
        &project_id,
        Some(&other_user_id),
        None,
        300,
        None,
    )
    .await?;
    assert!(
        wrong_user.is_none(),
        "a different user must not renew the lease"
    );

    let wrong_runtime = renew_long_lease(
        &pool,
        &lease.id,
        &project_id,
        Some(&user_id),
        Some(&other_runtime_id),
        300,
        None,
    )
    .await?;
    assert!(
        wrong_runtime.is_none(),
        "a supplied runtime must match the lease runtime"
    );

    let renewed = renew_long_lease(
        &pool,
        &lease.id,
        &project_id,
        Some(&user_id),
        None,
        300,
        None,
    )
    .await?
    .expect("the owning user should renew without an optional runtime filter");
    assert_eq!(renewed.id, lease.id);
    assert_eq!(renewed.user_id, Some(user_id));
    assert_eq!(renewed.runtime_id, Some(runtime_id));

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn acquire_fresh_lease_serializes_concurrent_first_claims() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping concurrent origins lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let user_ids = (0..6).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    for user_id in &user_ids {
        ensure_test_user(&pool, user_id).await?;
    }
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let barrier = Arc::new(tokio::sync::Barrier::new(user_ids.len()));
    let attempts = user_ids
        .into_iter()
        .map(|user_id| {
            let pool = pool.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                acquire_fresh_lease(&pool, &project_id, Some(&user_id), None, 60, None).await
            })
        })
        .collect::<Vec<_>>();

    let mut granted = 0;
    let mut conflicts = 0;
    for attempt in attempts {
        match attempt.await?? {
            LeaseAcquireOutcome::Granted(_) => granted += 1,
            LeaseAcquireOutcome::Conflict { .. } => conflicts += 1,
            LeaseAcquireOutcome::Renewed(_) => {
                anyhow::bail!("fresh lease acquisition unexpectedly renewed a lease")
            }
        }
    }
    assert_eq!(granted, 1);
    assert_eq!(conflicts, 5);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn project_memory_bootstrap_releases_lease_after_request_cancellation() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping project memory cancellation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, owner_user_id, project_type, status)
                 VALUES ($1, $2, 'customer', 'active')",
                &[&project_id, &owner_user_id],
            )
            .await?;
    }

    let apply_started = Arc::new(tokio::sync::Notify::new());
    let finish_apply = Arc::new(tokio::sync::Notify::new());
    let origin_app = axum::Router::new()
        .route(
            "/apply",
            axum::routing::post({
                let apply_started = apply_started.clone();
                let finish_apply = finish_apply.clone();
                move |_body: axum::body::Bytes| {
                    let apply_started = apply_started.clone();
                    let finish_apply = finish_apply.clone();
                    async move {
                        apply_started.notify_one();
                        finish_apply.notified().await;
                        AxumJson(json!({
                            "rev": "project-memory-rev",
                            "fileCount": 24,
                            "bytesWritten": 1024,
                        }))
                    }
                }
            }),
        )
        .fallback(|| async { StatusCode::NOT_FOUND });
    let origin_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin_address = origin_listener.local_addr()?;
    let origin_handle = tokio::spawn(async move {
        axum::serve(origin_listener, origin_app)
            .await
            .expect("serve project memory cancellation origin");
    });

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "project-memory-cancellation",
    );
    config.hosted_origin_endpoint = Some(format!("http://{origin_address}"));
    let app = crate::projects::router().with_state(build_test_state(pool.clone(), config));
    let bootstrap_task = tokio::spawn(async move {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/memory/bootstrap"))
                .header("authorization", "Bearer service-role-token")
                .body(Body::empty())
                .expect("project memory bootstrap request"),
        )
        .await
    });

    timeout(std::time::Duration::from_secs(10), apply_started.notified())
        .await
        .map_err(|_| anyhow::anyhow!("project memory apply did not start"))?;

    let lease_id: Uuid = {
        let connection = pool.get().await?;
        connection
            .query_one(
                "SELECT id
                 FROM workspace_leases
                 WHERE project_id = $1
                   AND status = 'active'
                   AND metadata ->> 'source' = 'project_memory_bootstrap'",
                &[&project_id],
            )
            .await?
            .get("id")
    };

    // Model a browser navigation dropping the controller request while the
    // origin mutation is in flight. The inner apply/release task must outlive
    // this outer request future.
    bootstrap_task.abort();
    let cancellation = bootstrap_task
        .await
        .expect_err("outer bootstrap request should be cancelled");
    assert!(cancellation.is_cancelled());
    finish_apply.notify_one();

    timeout(std::time::Duration::from_secs(10), async {
        loop {
            let connection = pool.get().await?;
            let row = connection
                .query_one(
                    "SELECT status, released_at
                     FROM workspace_leases
                     WHERE id = $1",
                    &[&lease_id],
                )
                .await?;
            let status: String = row.get("status");
            let released_at: Option<chrono::DateTime<Utc>> = row.get("released_at");
            if status == "released" && released_at.is_some() {
                return Ok::<(), anyhow::Error>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("detached project memory task did not release its lease"))??;

    origin_handle.abort();
    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn record_commit_receipt_persists_payload() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping commit receipt test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();

    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols)
                 VALUES ($1, $2, 'desktop', 'https://origin', ARRAY['webdav']::text[])",
                &[&origin_id, &project_id],
            )
            .await?;
    }

    let lease_outcome = acquire_lease(&pool, &project_id, Some(&user_id), None, 60, None).await?;
    let lease = match lease_outcome {
        LeaseAcquireOutcome::Granted(record) => record,
        other => panic!("expected granted lease, got {other:?}"),
    };

    let metadata = json!({ "paths": ["src/App.tsx"] });
    let receipt = record_commit_receipt(
        &pool,
        &project_id,
        &origin_id,
        Some(&lease.id),
        Some(&user_id),
        "rev-123",
        Some(1024),
        Some(3),
        Some(850),
        Some(&metadata),
    )
    .await?;
    assert_eq!(receipt.rev, "rev-123");
    assert_eq!(receipt.bytes_written, Some(1024));

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "SELECT user_id, metadata FROM workspace_commit_receipts WHERE id = $1",
                &[&receipt.id],
            )
            .await?;
        let stored_user: Option<Uuid> = row.get("user_id");
        let stored_metadata: Option<serde_json::Value> = row.get("metadata");
        assert_eq!(stored_user, Some(user_id));
        assert_eq!(stored_metadata, Some(metadata));
    }

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn record_access_grant_persists_audit_row() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping access grant test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let jti = Uuid::new_v4();
    let issued_at = Utc::now();
    let expires_at = issued_at + chrono::Duration::seconds(300);

    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols)
                 VALUES ($1, $2, 'desktop', 'https://origin', ARRAY['webdav']::text[])",
                &[&origin_id, &project_id],
            )
            .await?;
    }

    let lease_id = match acquire_lease(&pool, &project_id, Some(&user_id), None, 300, None).await? {
        LeaseAcquireOutcome::Granted(record) | LeaseAcquireOutcome::Renewed(record) => record.id,
        other => panic!("expected granted lease before access grant test, got {other:?}"),
    };

    let scopes = vec!["fs.read".to_string(), "fs.write".to_string()];
    let metadata = json!({ "ip": "127.0.0.1" });
    let ip = IpAddr::from_str("127.0.0.1").ok();
    let grant = record_access_grant(
        &pool,
        &project_id,
        &origin_id,
        Some(&user_id),
        Some(&lease_id),
        &scopes,
        "webdav",
        issued_at,
        expires_at,
        Some(&jti),
        ip,
        Some(&metadata),
    )
    .await?;
    assert_eq!(grant.origin_id, origin_id);
    assert_eq!(grant.scopes, scopes);

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "SELECT scopes, metadata FROM origin_access_grants WHERE id = $1",
                &[&grant.id],
            )
            .await?;
        let stored_scopes: Vec<String> = row.get("scopes");
        let stored_metadata: Option<serde_json::Value> = row.get("metadata");
        assert_eq!(stored_scopes, scopes);
        assert_eq!(stored_metadata, Some(metadata));
    }

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn post_access_token_mints_signed_token_and_publishes_event() -> anyhow::Result<()> {
    use axum::http::{HeaderMap, HeaderValue};
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping access token test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let runtime_lease_id = Uuid::new_v4();
    let origin_instance_id = Uuid::new_v4();
    let private_pem = test_origin_private_key();
    let public_pem = test_origin_public_key();

    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status, owner_user_id)
                 VALUES ($1, 'customer', 'active', $2)",
                &[&project_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes
                   (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 VALUES ($1, $2, 'instafy-cloud', 'ready', 600, now())",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases
                   (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now(), now())",
                &[&runtime_lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols)
                 VALUES ($1, $2, 'desktop', 'https://origin', ARRAY['webdav']::text[])",
                &[&origin_id, &project_id],
            )
            .await?;
        let protocols = vec!["webdav".to_string()];
        connection
            .execute(
                "INSERT INTO origin_instances
                   (id, project_id, runtime_id, lease_id, origin_id, required,
                    mode, status, endpoint, protocols, metadata)
                 VALUES
                   ($1, $2, $3, $4, $5, true, 'hosted', 'online',
                    'https://origin', $6::text[], '{}'::jsonb)",
                &[
                    &origin_instance_id,
                    &project_id,
                    &runtime_id,
                    &runtime_lease_id,
                    &origin_id,
                    &protocols,
                ],
            )
            .await?;
    }

    let lease_id = match acquire_lease(&pool, &project_id, Some(&user_id), None, 300, None).await? {
        LeaseAcquireOutcome::Granted(record) | LeaseAcquireOutcome::Renewed(record) => record.id,
        other => panic!("expected granted lease before issuing access token, got {other:?}"),
    };

    let config = build_app_config(private_pem, public_pem, "test-origin-key");

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);

    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_static("Bearer service-role-token"),
    );

    let request = AccessTokenRequest {
        project_id: project_id.to_string(),
        protocol: Some("webdav".to_string()),
        scopes: vec!["fs.write".to_string()],
        origin_id: Some(origin_id.to_string()),
        prefer_hosted: None,
        prefer_runtime: None,
        lease_id: Some(lease_id.to_string()),
        browser_session_id: None,
    };

    let response = post_access_token(
        axum::extract::State(state.clone()),
        headers,
        AxumJson(request),
    )
    .await
    .expect("access token issued");

    let token_value = response
        .get("token")
        .and_then(|value| value.as_str())
        .expect("token present")
        .to_string();

    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.validate_aud = false;
    let decoded = decode::<AccessTokenClaims>(
        &token_value,
        &DecodingKey::from_ed_pem(public_pem.as_bytes()).expect("decoding key"),
        &validation,
    )
    .expect("decode origin token");

    let origin_id_str = origin_id.to_string();
    assert_eq!(
        decoded.claims.origin_id.as_deref(),
        Some(origin_id_str.as_str())
    );
    assert_eq!(decoded.claims.project_id, project_id.to_string());
    assert_eq!(decoded.claims.scopes, vec!["fs.write"]);
    assert_eq!(decoded.claims.lease_id, Some(lease_id.to_string()));
    assert_eq!(decoded.claims.runtime_id, Some(runtime_id.to_string()));
    let bound_runtime_id: Option<Uuid> = pool
        .get()
        .await?
        .query_one(
            "SELECT runtime_id FROM workspace_leases WHERE id = $1",
            &[&lease_id],
        )
        .await?
        .get("runtime_id");
    assert_eq!(
        bound_runtime_id,
        Some(runtime_id),
        "origin selection must bind a previously runtime-neutral workspace lease"
    );

    let grants = {
        let connection = pool.get().await?;
        connection
            .query(
                "SELECT user_id, lease_id, scopes FROM origin_access_grants WHERE project_id = $1",
                &[&project_id],
            )
            .await?
    };
    assert_eq!(grants.len(), 1);
    let stored_scopes: Vec<String> = grants[0].get("scopes");
    assert_eq!(stored_scopes, vec!["fs.write"]);

    let origin_context = RequestContext {
        user_id: None,
        is_service_role: false,
        scoped_claims: Some(decoded.claims.clone()),
    };
    authorize_workspace_origin_git_write(&state, &origin_context, &project_id)
        .await
        .expect("active exact workspace lease authorizes controlled git write");

    let git_app = crate::origins::router().with_state(state.clone());
    let git_request = || {
        Request::builder()
            .method("POST")
            .uri(format!("/projects/{project_id}/git/access_token"))
            .header("authorization", format!("Bearer {token_value}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "scopes": ["git.read", "git.write"], "ttlSeconds": 600 }).to_string(),
            ))
    };
    let git_response = git_app.clone().oneshot(git_request()?).await?;
    assert_eq!(git_response.status(), StatusCode::OK);
    let git_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(git_response.into_body(), usize::MAX).await?)?;
    let git_token = git_payload
        .get("token")
        .and_then(serde_json::Value::as_str)
        .expect("git token present");
    let mut git_validation = Validation::new(Algorithm::EdDSA);
    git_validation.validate_aud = false;
    let decoded_git = decode::<AccessTokenClaims>(
        git_token,
        &DecodingKey::from_ed_pem(public_pem.as_bytes()).expect("git decoding key"),
        &git_validation,
    )
    .expect("decode git token");
    assert_eq!(decoded_git.claims.lease_id, Some(lease_id.to_string()));
    assert!(decoded_git.claims.exp - decoded_git.claims.iat <= 60);

    let mut mismatched_claims = decoded.claims.clone();
    mismatched_claims.sub = Uuid::new_v4().to_string();
    let mismatched_context = RequestContext {
        user_id: None,
        is_service_role: false,
        scoped_claims: Some(mismatched_claims),
    };
    assert!(
        authorize_workspace_origin_git_write(&state, &mismatched_context, &project_id)
            .await
            .is_err()
    );

    release_lease(
        &pool,
        &lease_id,
        &project_id,
        Some(&user_id),
        None,
        "released",
    )
    .await?
    .expect("workspace lease releases");
    assert!(
        authorize_workspace_origin_git_write(&state, &origin_context, &project_id)
            .await
            .is_err()
    );
    let after_release = git_app.oneshot(git_request()?).await?;
    assert_eq!(after_release.status(), StatusCode::UNAUTHORIZED);

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn post_access_token_recovers_stale_service_runtime_user_id() -> anyhow::Result<()> {
    use axum::http::{HeaderMap, HeaderValue};

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!(
            "skipping stale service runtime user access token test: TEST_DATABASE_URL not set"
        );
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let stale_service_user_id = Uuid::new_v4();
    let requested_service_user_id = Uuid::new_v4();
    let mut inserted_service_user = false;

    let valid_service_user_id = {
        let connection = pool.get().await?;
        let service_runtime_email = "service-runtime@instafy.dev".to_string();
        let valid_service_user_id = if let Some(row) = connection
            .query_opt(
                "SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1",
                &[&service_runtime_email],
            )
            .await?
        {
            row.get::<_, Uuid>("id")
        } else {
            inserted_service_user = true;
            connection
                .query_one(
                    "INSERT INTO auth.users (
                    instance_id,
                    id,
                    aud,
                    role,
                    email,
                    encrypted_password,
                    email_confirmed_at,
                    last_sign_in_at,
                    raw_app_meta_data,
                    raw_user_meta_data,
                    is_super_admin,
                    created_at,
                    updated_at
                ) VALUES (
                    $1,
                    $2,
                    'authenticated',
                    'authenticated',
                    $3,
                    'test-secret',
                    now(),
                    now(),
                    '{}'::jsonb,
                    '{}'::jsonb,
                    false,
                    now(),
                    now()
                )
                RETURNING id",
                    &[
                        &Uuid::nil(),
                        &requested_service_user_id,
                        &service_runtime_email,
                    ],
                )
                .await?
                .get::<_, Uuid>("id")
        };
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols)
                 VALUES ($1, $2, 'desktop', 'https://origin', ARRAY['webdav']::text[])",
                &[&origin_id, &project_id],
            )
            .await?;
        valid_service_user_id
    };

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    config.service_runtime_user_id = Some(stale_service_user_id);

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);

    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_static("Bearer service-role-token"),
    );

    let response = post_access_token(
        axum::extract::State(state),
        headers,
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("webdav".to_string()),
            scopes: vec!["fs.read".to_string()],
            origin_id: Some(origin_id.to_string()),
            prefer_hosted: None,
            prefer_runtime: None,
            lease_id: None,
            browser_session_id: None,
        }),
    )
    .await
    .expect("access token issued");

    let token_value = response
        .get("token")
        .and_then(|value| value.as_str())
        .expect("token present");
    let claims = decode_scoped_token(
        &build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-origin-key",
        ),
        token_value,
        "origin access token",
    )
    .expect("decode origin access token");
    assert_eq!(claims.sub, valid_service_user_id.to_string());

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "SELECT user_id FROM origin_access_grants WHERE project_id = $1 ORDER BY issued_at DESC LIMIT 1",
                &[&project_id],
            )
            .await?;
        let stored_user_id: Option<Uuid> = row.get("user_id");
        assert_eq!(stored_user_id, Some(valid_service_user_id));
    }

    cleanup_origin_project(&pool, &project_id).await?;
    if inserted_service_user {
        cleanup_test_user(&pool, &valid_service_user_id).await?;
    }

    Ok(())
}

#[tokio::test]
async fn post_access_token_requires_managed_cloud_for_browser_runtime_origin() -> anyhow::Result<()>
{
    use axum::http::{HeaderMap, HeaderValue};

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping access token preferred runtime test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let origin_instance_id = Uuid::new_v4();
    let runtime_origin_id = Uuid::new_v4();
    let hosted_origin_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("instafy:hosted-origin:{project_id}").as_bytes(),
    );

    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 VALUES ($1, $2, 'self_hosted', 'ready', 600, now())",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now(), now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols)
                 VALUES
                   ($1, $2, 'hosted', 'http://127.0.0.1:54333', ARRAY['http']::text[]),
                   ($3, $2, 'hosted', 'http://host.docker.internal:57580', ARRAY['http']::text[])",
                &[&hosted_origin_id, &project_id, &runtime_origin_id],
            )
            .await?;
        let protocols: Vec<String> = vec!["http".to_string()];
        connection
            .execute(
                "INSERT INTO origin_instances (id, project_id, runtime_id, lease_id, origin_id, required, mode, status, endpoint, protocols, metadata)
                 VALUES ($1, $2, $3, $4, $5, true, 'hosted', 'online', 'http://host.docker.internal:57580', $6::text[], '{}'::jsonb)",
                &[
                    &origin_instance_id,
                    &project_id,
                    &runtime_id,
                    &lease_id,
                    &runtime_origin_id,
                    &protocols,
                ],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    config.hosted_origin_endpoint = Some("http://127.0.0.1:54333".to_string());
    config.service_runtime_user_id = Some(user_id);

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);

    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_static("Bearer service-role-token"),
    );

    let (status, error) = post_access_token(
        axum::extract::State(state.clone()),
        headers.clone(),
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("http".to_string()),
            scopes: vec!["browser.view".to_string()],
            origin_id: None,
            prefer_hosted: None,
            prefer_runtime: Some(runtime_id.to_string()),
            lease_id: None,
            browser_session_id: Some("browser-test-session".to_string()),
        }),
    )
    .await
    .expect_err("self-hosted runtime must not receive a Shared Browser token");
    assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
    assert!(error.0.message.contains("managed Instafy Cloud"));

    {
        let connection = pool.get().await?;
        let grant_count: i64 = connection
            .query_one(
                "SELECT count(*) FROM origin_access_grants WHERE project_id = $1",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(grant_count, 0);
        let cloud_looking_custom_capabilities = json!({ "agent": true, "origin": true });
        connection
            .execute(
                "UPDATE runtimes
                 SET provider = 'instafy-cloud-custom', capabilities = $2
                 WHERE id = $1",
                &[&runtime_id, &cloud_looking_custom_capabilities],
            )
            .await?;
    }

    let (status, error) = post_access_token(
        axum::extract::State(state.clone()),
        headers.clone(),
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("http".to_string()),
            scopes: vec!["browser.view".to_string()],
            origin_id: None,
            prefer_hosted: None,
            prefer_runtime: Some(runtime_id.to_string()),
            lease_id: None,
            browser_session_id: Some("browser-test-session".to_string()),
        }),
    )
    .await
    .expect_err("cloud-looking custom runtime must not receive a Shared Browser token");
    assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
    assert!(error.0.message.contains("managed Instafy Cloud"));

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "UPDATE runtimes
                 SET provider = 'instafy-cloud', capabilities = '{}'::jsonb
                 WHERE id = $1",
                &[&runtime_id],
            )
            .await?;
    }

    let response = post_access_token(
        axum::extract::State(state.clone()),
        headers.clone(),
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("http".to_string()),
            scopes: vec!["browser.view".to_string()],
            origin_id: None,
            prefer_hosted: None,
            prefer_runtime: Some(runtime_id.to_string()),
            lease_id: None,
            browser_session_id: Some("browser-test-session".to_string()),
        }),
    )
    .await
    .expect("access token issued");

    let response_origin_id = response
        .get("originId")
        .and_then(|value| value.as_str())
        .expect("origin id present");
    assert_eq!(response_origin_id, runtime_origin_id.to_string());

    let token_value = response
        .get("token")
        .and_then(|value| value.as_str())
        .expect("token present");
    let claims = decode_scoped_token(&state.config, token_value, "origin access token")
        .expect("decode origin access token");
    assert_eq!(
        claims.origin_id.as_deref(),
        Some(runtime_origin_id.to_string().as_str())
    );
    assert_eq!(
        claims.runtime_id.as_deref(),
        Some(runtime_id.to_string().as_str())
    );
    assert_eq!(
        claims.prefer_runtime.as_deref(),
        Some(runtime_id.to_string().as_str())
    );

    let (status, _) = post_access_token(
        axum::extract::State(state.clone()),
        headers.clone(),
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("http".to_string()),
            scopes: vec!["browser.control".to_string()],
            origin_id: Some(hosted_origin_id.to_string()),
            prefer_hosted: None,
            prefer_runtime: Some(runtime_id.to_string()),
            lease_id: None,
            browser_session_id: Some("browser-test-session".to_string()),
        }),
    )
    .await
    .expect_err("unassociated origin must not receive a runtime-bound browser token");
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "UPDATE origin_instances SET status = 'offline' WHERE id = $1",
                &[&origin_instance_id],
            )
            .await?;
    }

    let (status, _) = post_access_token(
        axum::extract::State(state),
        headers,
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("http".to_string()),
            scopes: vec!["browser.view".to_string()],
            origin_id: Some(runtime_origin_id.to_string()),
            prefer_hosted: None,
            prefer_runtime: Some(runtime_id.to_string()),
            lease_id: None,
            browser_session_id: Some("browser-test-session".to_string()),
        }),
    )
    .await
    .expect_err("offline browser origin must not receive a runtime-bound token");
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);

    cleanup_origin_project(&pool, &project_id).await?;

    Ok(())
}

#[tokio::test]
async fn post_access_token_prefers_hosted_origin_when_prefer_hosted_is_set() -> anyhow::Result<()> {
    use axum::http::{HeaderMap, HeaderValue};

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping access token preferred hosted test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let foreign_project_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let foreign_runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let origin_instance_id = Uuid::new_v4();
    let runtime_origin_id = Uuid::new_v4();
    let hosted_origin_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("instafy:hosted-origin:{project_id}").as_bytes(),
    );

    ensure_test_user(&pool, &user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&foreign_project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 VALUES ($1, $2, 'runtime', 'ready', 600, now())",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 VALUES ($1, $2, 'runtime', 'ready', 600, now())",
                &[&foreign_runtime_id, &foreign_project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now(), now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO workspace_origins (id, project_id, mode, endpoint, protocols)
                 VALUES
                   ($1, $2, 'hosted', 'http://127.0.0.1:54333', ARRAY['http']::text[]),
                   ($3, $2, 'hosted', 'http://host.docker.internal:57580', ARRAY['http']::text[])",
                &[&hosted_origin_id, &project_id, &runtime_origin_id],
            )
            .await?;
        let protocols: Vec<String> = vec!["http".to_string()];
        connection
            .execute(
                "INSERT INTO origin_instances (id, project_id, runtime_id, lease_id, origin_id, required, mode, status, endpoint, protocols, metadata)
                 VALUES ($1, $2, $3, $4, $5, true, 'hosted', 'online', 'http://host.docker.internal:57580', $6::text[], '{}'::jsonb)",
                &[
                    &origin_instance_id,
                    &project_id,
                    &runtime_id,
                    &lease_id,
                    &runtime_origin_id,
                    &protocols,
                ],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    config.hosted_origin_endpoint = Some("http://127.0.0.1:54333".to_string());
    config.service_runtime_user_id = Some(user_id);

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "default".to_string(),
        RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        },
    );
    let provider_registry =
        crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
    let ota_registry = test_ota_registry(&config);

    let state = AppState {
        config,
        pool: pool.clone(),
        rate_limiter: RateLimiter::new(),
        connection_limiter: ConnectionLimiter::new(),
        events: crate::state::EventHub::new(),
        http_client: reqwest::Client::new(),
        origin_proxy_client: reqwest::Client::new(),
        runtime_activity: crate::state::RuntimeActivityTracker::new(150),
        local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
        runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
        runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
        provider_registry,
        tunnel_broker: None,
        device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
        ota_registry,
        desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
        credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_static("Bearer service-role-token"),
    );

    let response = post_access_token(
        axum::extract::State(state.clone()),
        headers.clone(),
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("http".to_string()),
            scopes: vec!["fs.read".to_string()],
            origin_id: None,
            prefer_hosted: Some(true),
            prefer_runtime: Some(runtime_id.to_string()),
            lease_id: None,
            browser_session_id: None,
        }),
    )
    .await
    .expect("access token issued");

    let response_origin_id = response
        .get("originId")
        .and_then(|value| value.as_str())
        .expect("origin id present");
    assert_eq!(response_origin_id, hosted_origin_id.to_string());

    let token_value = response
        .get("token")
        .and_then(|value| value.as_str())
        .expect("token present");
    let claims = decode_scoped_token(&state.config, token_value, "origin access token")
        .expect("decode origin access token");
    assert_eq!(
        claims.origin_id.as_deref(),
        Some(hosted_origin_id.to_string().as_str())
    );
    assert_eq!(claims.runtime_id, None);
    assert_eq!(claims.prefer_runtime, None);

    let (status, _) = post_access_token(
        axum::extract::State(state),
        headers,
        AxumJson(AccessTokenRequest {
            project_id: project_id.to_string(),
            protocol: Some("http".to_string()),
            scopes: vec!["fs.read".to_string()],
            origin_id: None,
            prefer_hosted: Some(true),
            prefer_runtime: Some(foreign_runtime_id.to_string()),
            lease_id: None,
            browser_session_id: None,
        }),
    )
    .await
    .expect_err("cross-project preferred runtime must not become a token claim");
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_origin_project(&pool, &foreign_project_id).await?;

    Ok(())
}

#[tokio::test]
async fn ensure_conversation_record_creates_missing_conversation() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping conversation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    create_conversation_tables(&mut client).await?;

    let project_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO projects (id, project_type, status) VALUES ($1, 'sandbox', 'active')",
            &[&project_id],
        )
        .await?;

    let request_body = DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Plan a launch".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: None,
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: None,
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    };

    let mut normalized = dispatch::normalize_dispatch_request(request_body)
        .map_err(|error| controller_error("normalize dispatch request", error))?;
    assert!(normalized.conversation_id.is_none());

    let conversation_id = Uuid::new_v4();
    normalized.conversation_id = Some(conversation_id);
    normalized.conversation_raw = Some(conversation_id.to_string());

    let context = RequestContext {
        user_id: Some(Uuid::new_v4()),
        is_service_role: false,
        scoped_claims: None,
    };

    let transaction = client.transaction().await?;
    let project = load_project_record(&transaction, &project_id)
        .await
        .map_err(|error| controller_error("load project", error))?;

    let conversation = conversations::ensure_conversation_record(
        &transaction,
        &project,
        &mut normalized,
        &context,
    )
    .await
    .map_err(|error| controller_error("ensure conversation", error))?;

    assert_eq!(conversation.id, conversation_id);
    assert!(normalized.conversation_is_new);

    let row = transaction
        .query_one(
            "SELECT count(*) FROM conversations WHERE id = $1",
            &[&conversation_id],
        )
        .await?;
    let count: i64 = row.get(0);
    assert_eq!(count, 1);

    transaction.rollback().await?;
    connection_handle.abort();

    Ok(())
}

async fn seed_group_participation_project(
    pool: &PgPool,
    org_id: &Uuid,
    project_id: &Uuid,
    owner_user_id: &Uuid,
    other_user_id: &Uuid,
    label: &str,
) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into organizations (id, slug, name) values ($1, $2, $3)",
            &[org_id, &format!("{label}-{org_id}"), &label],
        )
        .await?;
    connection
        .execute(
            "insert into org_memberships (org_id, user_id, role)
             values ($1, $2, 'owner'), ($1, $3, 'builder')",
            &[org_id, owner_user_id, other_user_id],
        )
        .await?;
    connection
        .execute(
            "insert into projects (id, org_id, name, owner_user_id, project_type, status)
             values ($1, $2, $3, $4, 'customer', 'active')",
            &[project_id, org_id, &label, owner_user_id],
        )
        .await?;
    connection
        .execute(
            "insert into project_memberships (project_id, user_id, role)
             values ($1, $2, 'builder')",
            &[project_id, other_user_id],
        )
        .await?;
    Ok(())
}

fn ambient_group_dispatch_request(
    project_id: &Uuid,
    conversation_id: &Uuid,
) -> anyhow::Result<dispatch::DispatchPromptNormalized> {
    dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Should we keep the blue version?".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": ["octo"], "mentions": [] }
        })),
        conversation_metadata: Some(json!({ "visibility": "public" })),
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize ambient group dispatch", error))
}

fn mint_agent_message_token(config: &AppConfig, project_id: &Uuid) -> anyhow::Result<String> {
    let minted = mint_scoped_token(
        config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: "agent:skill-mode-test".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: None,
            scopes: vec!["agent.message".to_string(), "agent.complete".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint agent token", error))?;
    Ok(minted.token)
}

async fn post_agent_endpoint(
    state: &AppState,
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> anyhow::Result<StatusCode> {
    let response = agent::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    Ok(response.status())
}

#[tokio::test]
async fn automation_silence_is_opt_in_success_only_and_keeps_runs_observable() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping silent automation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &teammate_user_id).await?;
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &teammate_user_id,
        "Silent automation test",
    )
    .await?;

    struct CompletionCase {
        name: &'static str,
        silent: bool,
        stream_plain_text_decline: bool,
        outcome: &'static str,
        summary: Option<&'static str>,
        error: Option<&'static str>,
        expected_content: Option<&'static str>,
    }

    let cases = [
        CompletionCase {
            name: "opt out sentinel",
            silent: false,
            stream_plain_text_decline: false,
            outcome: "succeeded",
            summary: Some("NO_RESPONSE"),
            error: None,
            expected_content: Some("NO_RESPONSE"),
        },
        CompletionCase {
            name: "quiet success",
            silent: true,
            stream_plain_text_decline: false,
            outcome: "succeeded",
            summary: Some("NO_RESPONSE"),
            error: None,
            expected_content: None,
        },
        CompletionCase {
            name: "quiet streamed plain-text success",
            silent: true,
            stream_plain_text_decline: true,
            outcome: "succeeded",
            summary: Some("NO_RESPONSE"),
            error: None,
            expected_content: None,
        },
        CompletionCase {
            name: "real finding",
            silent: true,
            stream_plain_text_decline: false,
            outcome: "succeeded",
            summary: Some("Dependency lockfile changed."),
            error: None,
            expected_content: Some("Dependency lockfile changed."),
        },
        CompletionCase {
            name: "failed check",
            silent: true,
            stream_plain_text_decline: false,
            outcome: "failed",
            summary: Some("NO_RESPONSE"),
            error: Some("Automation check failed."),
            expected_content: Some("Automation check failed."),
        },
        CompletionCase {
            name: "missing output",
            silent: true,
            stream_plain_text_decline: false,
            outcome: "succeeded",
            summary: None,
            error: None,
            expected_content: Some("finished with status success"),
        },
    ];

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                 ) values ($1, $2, 'openai_api_key', 'Silent automation test',
                           'test-nonce', 'test-ciphertext', '{}'::jsonb, true)",
                &[&credential_id, &owner_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "silent-automation",
    );
    let state = build_test_state(pool.clone(), config.clone());
    let token = mint_agent_message_token(&config, &project_id)?;

    // Dispatch sequentially. The scheduler itself supports concurrency, but
    // concurrently bootstrapping several default-agent rows for the same new
    // test user would test profile races rather than automation silence.
    for case in cases.iter() {
        let automation_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversations (
                     id, project_id, created_by, metadata, visibility, thread_kind
                 ) values ($1, $2, $3, $4::jsonb, 'private', 'automation')",
                &[
                    &conversation_id,
                    &project_id,
                    &owner_user_id,
                    &PgJson(&json!({ "title": case.name })),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_participants (
                     conversation_id, user_id, role, added_by
                 ) values ($1, $2, 'owner', $2)",
                &[&conversation_id, &owner_user_id],
            )
            .await?;
        if case.silent {
            connection
                .execute(
                    "insert into automations (
                         id, project_id, user_id, name, prompt_text, schedule_kind,
                         interval_hours, timezone, runtime_mode, conversation_id, status,
                         next_run_at, silent_when_nothing_to_report
                     ) values (
                         $1, $2, $3, $4, 'Check the project and report meaningful changes.',
                         'hourly', 24, 'UTC', 'existing', $5, 'active', now(), true
                     )",
                    &[
                        &automation_id,
                        &project_id,
                        &owner_user_id,
                        &case.name,
                        &conversation_id,
                    ],
                )
                .await?;
        } else {
            // Omit the new column to prove the database default preserves
            // the historical always-report behavior.
            connection
                .execute(
                    "insert into automations (
                         id, project_id, user_id, name, prompt_text, schedule_kind,
                         interval_hours, timezone, runtime_mode, conversation_id, status,
                         next_run_at
                     ) values (
                         $1, $2, $3, $4, 'Check the project and report meaningful changes.',
                         'hourly', 24, 'UTC', 'existing', $5, 'active', now()
                     )",
                    &[
                        &automation_id,
                        &project_id,
                        &owner_user_id,
                        &case.name,
                        &conversation_id,
                    ],
                )
                .await?;
        }
        drop(connection);

        automations::automation_scheduler_tick(&state).await?;
        let connection = pool.get().await?;
        let job_row = connection
            .query_one(
                "select id, run_id, payload from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        let job_id: Uuid = job_row.get("id");
        let run_id: Uuid = job_row
            .get::<_, Option<Uuid>>("run_id")
            .expect("automation run id");
        let job_payload: PgJson<serde_json::Value> = job_row.get("payload");
        assert_eq!(
            job_payload.0["metadata"]["groupParticipation"]["decision"]
                == json!("agent_evaluation"),
            case.silent,
            "unexpected evaluation marker for {}",
            case.name
        );
        if case.silent {
            assert_eq!(
                job_payload.0["metadata"]["groupParticipation"]["reason"],
                json!(crate::group_participation::AUTOMATION_NOTHING_TO_REPORT_REASON)
            );
            assert_ne!(
                job_payload.0["metadata"]["managedAiBillingDeferred"],
                json!(true),
                "automation silence must not opt into ambient deferred billing"
            );
            assert!(job_payload.0["prompt_text"]
                .as_str()
                .is_some_and(|prompt| prompt.contains("Scheduled automation run")));
        }
        if case.stream_plain_text_decline {
            connection
                .execute(
                    "update agent_jobs set status = 'leased' where id = $1",
                    &[&job_id],
                )
                .await?;
        }
        drop(connection);

        // Ignore any dispatch-time delivery attempts; the assertions below
        // cover only the streamed/final result paths.
        crate::notifications::take_test_push_enqueue_count(conversation_id);

        if case.stream_plain_text_decline {
            let status = post_agent_endpoint(
                &state,
                &token,
                "/agent/message",
                json!({
                    "job_id": job_id,
                    "content": "NO_RESPONSE",
                    "message_type": "status",
                    "metadata": {
                        "kind": "agent_message",
                        "event": {
                            "type": "item.completed",
                            "item": { "type": "agent_message", "text": "NO_RESPONSE" }
                        }
                    }
                }),
            )
            .await?;
            assert_eq!(
                status,
                StatusCode::OK,
                "streamed plain-text decline failed for {}",
                case.name
            );
            assert_eq!(
                crate::notifications::take_test_push_enqueue_count(conversation_id),
                0,
                "streamed decline must not enqueue a push for {}",
                case.name
            );
        }

        let mut completion = json!({
            "job_id": job_id,
            "outcome": case.outcome,
        });
        if let Some(summary) = case.summary {
            completion["summary"] = json!(summary);
        }
        if let Some(error) = case.error {
            completion["error_message"] = json!(error);
        }
        let status = post_agent_endpoint(&state, &token, "/agent/complete", completion).await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "completion failed for {}",
            case.name
        );
        assert_eq!(
            crate::notifications::take_test_push_enqueue_count(conversation_id),
            usize::from(case.expected_content.is_some()),
            "unexpected completion push enqueue count for {}",
            case.name
        );

        let connection = pool.get().await?;
        let assistant_contents: Vec<String> = connection
            .query(
                "select content from conversation_messages
                 where conversation_id = $1
                   and role = 'assistant'
                   and coalesce(metadata ->> 'kind', '') <> 'runtime_alert'
                   and lower(coalesce(metadata ->> 'messageType', '')) <> 'token_usage'
                 order by created_at",
                &[&conversation_id],
            )
            .await?
            .into_iter()
            .map(|row| row.get("content"))
            .collect();
        match case.expected_content {
            Some(expected) => {
                assert_eq!(
                    assistant_contents.len(),
                    1,
                    "{} must stay visible",
                    case.name
                );
                assert!(
                    assistant_contents[0].contains(expected),
                    "unexpected message for {}: {:?}",
                    case.name,
                    assistant_contents
                );
            }
            None => assert!(
                assistant_contents.is_empty(),
                "{} must not persist a completion message",
                case.name
            ),
        }

        let job = connection
            .query_one(
                "select status, payload from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(
            job.get::<_, String>("status"),
            if case.outcome == "succeeded" {
                "completed"
            } else {
                "failed"
            }
        );
        let run = connection
            .query_one(
                "select status, metadata from runs where id = $1",
                &[&run_id],
            )
            .await?;
        assert_eq!(
            run.get::<_, String>("status"),
            if case.outcome == "succeeded" {
                "success"
            } else {
                "failed"
            }
        );
        let automation = connection
            .query_one(
                "select last_run_at, last_error from automations where id = $1",
                &[&automation_id],
            )
            .await?;
        assert!(automation
            .get::<_, Option<chrono::DateTime<Utc>>>("last_run_at")
            .is_some());
        assert!(automation.get::<_, Option<String>>("last_error").is_none());

        if case.expected_content.is_none() {
            let job_payload: PgJson<serde_json::Value> = job.get("payload");
            let run_metadata: PgJson<serde_json::Value> = run.get("metadata");
            assert_eq!(
                job_payload.0["metadata"]["groupParticipation"]["decision"],
                json!("silent")
            );
            assert_eq!(
                run_metadata.0["groupParticipation"]["decision"],
                json!("silent")
            );
        }
    }

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &teammate_user_id).await?;
    Ok(())
}

async fn automation_json_request(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: serde_json::Value,
) -> anyhow::Result<(StatusCode, serde_json::Value)> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let payload = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Ok((status, payload))
}

#[tokio::test]
async fn automation_update_keeps_identity_and_reschedules_only_on_schedule_change(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping automation update test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &teammate_user_id).await?;
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &teammate_user_id,
        "Automation update test",
    )
    .await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "automation-update",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue automation owner token", error))?
        .token;
    let teammate_token = crate::auth::issue_controller_token(&config, &teammate_user_id)
        .map_err(|error| controller_error("issue automation teammate token", error))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = automations::router().with_state(state);

    let (status, created) = automation_json_request(
        &app,
        "POST",
        &format!("/projects/{project_id}/automations"),
        &owner_token,
        json!({
            "name": "Dependency check",
            "promptText": "Report dependency changes.",
            "scheduleKind": "hourly",
            "intervalHours": 24,
            "timezone": "UTC",
            "runtimeMode": "existing"
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "create failed: {created}");
    let automation_id = created["id"].as_str().expect("automation id").to_string();
    let conversation_id = created["conversationId"]
        .as_str()
        .expect("automation conversation id")
        .to_string();
    let initial_next_run_at = created["nextRunAt"]
        .as_str()
        .expect("initial next run")
        .to_string();
    let automation_path = format!("/automations/{automation_id}");

    // A prompt/runtime-settings edit keeps the automation identity, its private
    // conversation, and its pending next run.
    let (status, updated) = automation_json_request(
        &app,
        "PATCH",
        &automation_path,
        &owner_token,
        json!({
            "promptText": "Report dependency and license changes.",
            "silentWhenNothingToReport": true
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "prompt update failed: {updated}");
    assert_eq!(updated["id"], json!(automation_id));
    assert_eq!(updated["conversationId"], json!(conversation_id));
    assert_eq!(
        updated["promptText"],
        json!("Report dependency and license changes.")
    );
    assert_eq!(updated["silentWhenNothingToReport"], json!(true));
    assert_eq!(updated["scheduleKind"], json!("hourly"));
    assert_eq!(updated["intervalHours"], json!(24));
    assert_eq!(updated["status"], json!("active"));
    assert_eq!(
        updated["nextRunAt"],
        json!(initial_next_run_at),
        "prompt edits must not reschedule the pending run"
    );

    // A schedule change recomputes the next run with the new schedule and keeps
    // the previously edited prompt.
    let (status, rescheduled) = automation_json_request(
        &app,
        "PATCH",
        &automation_path,
        &owner_token,
        json!({
            "scheduleKind": "weekly",
            "byDay": ["we", "mo"],
            "byHour": 7,
            "byMinute": 30,
            "timezone": "Europe/Vienna"
        }),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "schedule update failed: {rescheduled}"
    );
    assert_eq!(rescheduled["id"], json!(automation_id));
    assert_eq!(rescheduled["conversationId"], json!(conversation_id));
    assert_eq!(rescheduled["scheduleKind"], json!("weekly"));
    assert_eq!(rescheduled["byDay"], json!(["mo", "we"]));
    assert_eq!(rescheduled["byHour"], json!(7));
    assert_eq!(rescheduled["byMinute"], json!(30));
    assert_eq!(rescheduled["timezone"], json!("Europe/Vienna"));
    assert_eq!(rescheduled["intervalHours"], serde_json::Value::Null);
    assert_eq!(
        rescheduled["promptText"],
        json!("Report dependency and license changes.")
    );
    assert_ne!(rescheduled["nextRunAt"], json!(initial_next_run_at));
    let next_run_at = chrono::DateTime::parse_from_rfc3339(
        rescheduled["nextRunAt"]
            .as_str()
            .expect("rescheduled next run"),
    )?
    .with_timezone(&Utc);
    let now = Utc::now();
    assert!(next_run_at > now);
    assert!(next_run_at <= now + ChronoDuration::days(8));
    let local_next_run = next_run_at.with_timezone(&chrono_tz::Europe::Vienna);
    assert!(matches!(
        chrono::Datelike::weekday(&local_next_run),
        chrono::Weekday::Mon | chrono::Weekday::Wed
    ));
    assert_eq!(chrono::Timelike::hour(&local_next_run), 7);
    assert_eq!(chrono::Timelike::minute(&local_next_run), 30);
    let weekly_next_run_at = rescheduled["nextRunAt"].clone();

    // Pause/resume semantics are unchanged: pausing keeps the pending run and
    // resuming recomputes it from the current schedule.
    let (status, paused) = automation_json_request(
        &app,
        "PATCH",
        &automation_path,
        &owner_token,
        json!({ "status": "paused" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "pause failed: {paused}");
    assert_eq!(paused["status"], json!("paused"));
    assert_eq!(paused["nextRunAt"], weekly_next_run_at);
    let (status, resumed) = automation_json_request(
        &app,
        "PATCH",
        &automation_path,
        &owner_token,
        json!({ "status": "active" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "resume failed: {resumed}");
    assert_eq!(resumed["status"], json!("active"));
    let resumed_next_run_at = chrono::DateTime::parse_from_rfc3339(
        resumed["nextRunAt"].as_str().expect("resumed next run"),
    )?
    .with_timezone(&Utc);
    assert!(resumed_next_run_at > Utc::now());
    assert_eq!(
        chrono::Timelike::hour(&resumed_next_run_at.with_timezone(&chrono_tz::Europe::Vienna)),
        7
    );

    // Nothing to update is a client error rather than a silent rewrite.
    let (status, rejected) =
        automation_json_request(&app, "PATCH", &automation_path, &owner_token, json!({})).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "empty update: {rejected}");

    // Project teammates who do not own the automation cannot edit it.
    let (status, denied) = automation_json_request(
        &app,
        "PATCH",
        &automation_path,
        &teammate_token,
        json!({ "promptText": "Exfiltrate the repository." }),
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "teammate update: {denied}");

    let row = pool
        .get()
        .await?
        .query_one(
            "select prompt_text, conversation_id, schedule_kind
             from automations where id = $1",
            &[&Uuid::from_str(&automation_id)?],
        )
        .await?;
    assert_eq!(
        row.get::<_, String>("prompt_text"),
        "Report dependency and license changes."
    );
    assert_eq!(
        row.get::<_, Option<Uuid>>("conversation_id"),
        Some(Uuid::from_str(&conversation_id)?)
    );
    assert_eq!(row.get::<_, String>("schedule_kind"), "weekly");

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &teammate_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn automation_result_visibility_controls_team_thread_access() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping automation result visibility test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &teammate_user_id).await?;
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &teammate_user_id,
        "Automation result visibility",
    )
    .await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "automation-result-visibility",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| controller_error("issue owner token", error))?
        .token;
    let teammate_token = crate::auth::issue_controller_token(&config, &teammate_user_id)
        .map_err(|error| controller_error("issue teammate token", error))?
        .token;
    let app = automations::router()
        .merge(conversations::router())
        .with_state(build_test_state(pool.clone(), config));

    // Owner creates an automation that shares its result thread with the team.
    let create_team = |body: serde_json::Value| {
        let app = app.clone();
        let owner_token = owner_token.clone();
        async move {
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/projects/{project_id}/automations"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {owner_token}"),
                    )
                    .body(Body::from(body.to_string()))
                    .expect("build create request"),
            )
            .await
        }
    };

    let team_response = create_team(json!({
        "name": "Team dependency check",
        "scheduleKind": "hourly",
        "intervalHours": 24,
        "timezone": "UTC",
        "resultVisibility": "team",
    }))
    .await?;
    assert_eq!(team_response.status(), StatusCode::OK);
    let team_body = to_bytes(team_response.into_body(), usize::MAX).await?;
    let team_json: serde_json::Value = serde_json::from_slice(&team_body)?;
    assert_eq!(team_json["resultVisibility"], json!("team"));
    let team_conversation_id = team_json["conversationId"]
        .as_str()
        .expect("team automation conversation id")
        .to_string();

    // Owner creates a default automation; its result thread stays private.
    let private_response = create_team(json!({
        "name": "Private dependency check",
        "scheduleKind": "hourly",
        "intervalHours": 24,
        "timezone": "UTC",
    }))
    .await?;
    assert_eq!(private_response.status(), StatusCode::OK);
    let private_body = to_bytes(private_response.into_body(), usize::MAX).await?;
    let private_json: serde_json::Value = serde_json::from_slice(&private_body)?;
    assert_eq!(private_json["resultVisibility"], json!("private"));
    let private_automation_id = private_json["id"]
        .as_str()
        .expect("private automation id")
        .to_string();
    let private_conversation_id = private_json["conversationId"]
        .as_str()
        .expect("private automation conversation id")
        .to_string();

    // A non-owner teammate lists the project's automation threads.
    let list_automation_conversations = |token: String| {
        let app = app.clone();
        async move {
            let response = app
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri(format!(
                            "/projects/{project_id}/conversations?threadKind=automation"
                        ))
                        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                        .body(Body::empty())
                        .expect("build list request"),
                )
                .await
                .expect("list conversations");
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("read list body");
            let value: serde_json::Value = serde_json::from_slice(&body).expect("parse list body");
            value
                .as_array()
                .expect("conversation list array")
                .iter()
                .filter_map(|entry| entry["id"].as_str().map(str::to_string))
                .collect::<Vec<String>>()
        }
    };

    let teammate_before = list_automation_conversations(teammate_token.clone()).await;
    assert!(
        teammate_before.contains(&team_conversation_id),
        "teammate must see the team-visible automation thread"
    );
    assert!(
        !teammate_before.contains(&private_conversation_id),
        "teammate must not see the private automation thread"
    );

    // Owner flips the private automation to team visibility. A visibility-only
    // PATCH must not reset the active automation's schedule anchor.
    let next_run_at_before = private_json["nextRunAt"]
        .as_str()
        .expect("active automation must have nextRunAt")
        .to_string();
    let patch_automation = |body: serde_json::Value| {
        let app = app.clone();
        let owner_token = owner_token.clone();
        let private_automation_id = private_automation_id.clone();
        async move {
            let response = app
                .oneshot(
                    Request::builder()
                        .method("PATCH")
                        .uri(format!("/automations/{private_automation_id}"))
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .header(
                            axum::http::header::AUTHORIZATION,
                            format!("Bearer {owner_token}"),
                        )
                        .body(Body::from(body.to_string()))
                        .expect("build patch request"),
                )
                .await
                .expect("patch automation");
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("read patch body");
            serde_json::from_slice::<serde_json::Value>(&body).expect("parse patch body")
        }
    };

    let patch_json = patch_automation(json!({ "resultVisibility": "team" })).await;
    assert_eq!(patch_json["resultVisibility"], json!("team"));
    assert_eq!(
        patch_json["nextRunAt"],
        json!(next_run_at_before),
        "a visibility-only update must leave nextRunAt untouched"
    );

    // Changing the effective schedule must recompute nextRunAt.
    let reschedule_json = patch_automation(json!({ "intervalHours": 6 })).await;
    assert_eq!(reschedule_json["intervalHours"], json!(6));
    let next_run_at_after = reschedule_json["nextRunAt"]
        .as_str()
        .expect("rescheduled automation must have nextRunAt");
    assert_ne!(
        next_run_at_after, next_run_at_before,
        "a schedule change must recompute nextRunAt"
    );

    let teammate_after = list_automation_conversations(teammate_token.clone()).await;
    assert!(
        teammate_after.contains(&private_conversation_id),
        "the flipped automation thread must become visible to the teammate"
    );

    // Invalid enum values are rejected.
    let invalid_response = create_team(json!({
        "name": "Invalid visibility",
        "scheduleKind": "hourly",
        "intervalHours": 24,
        "timezone": "UTC",
        "resultVisibility": "everyone",
    }))
    .await?;
    assert_eq!(invalid_response.status(), StatusCode::BAD_REQUEST);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &teammate_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn skill_mode_ambient_turn_dispatches_evaluation_and_swallows_decline() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping skill-mode decline test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &other_user_id,
        "Skill mode decline test",
    )
    .await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "skill-mode-decline",
    );
    let state = build_test_state(pool.clone(), config.clone());

    let request = ambient_group_dispatch_request(&project_id, &conversation_id)?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process skill-mode ambient dispatch", error))?;

    assert_eq!(
        response.status, "queued",
        "skill mode must dispatch instead of record-only silencing"
    );
    assert!(response.run_id.is_some(), "an evaluation run must exist");

    let connection = pool.get().await?;
    let message = connection
        .query_one(
            "select metadata from conversation_messages
             where conversation_id = $1 and role = 'user'",
            &[&conversation_id],
        )
        .await?;
    let message_metadata: PgJson<serde_json::Value> = message.get("metadata");
    assert_eq!(
        message_metadata.0["groupParticipation"]["decision"],
        json!("agent_evaluation")
    );
    assert_eq!(
        message_metadata.0["groupParticipation"]["reason"],
        json!("skill_mode_ambient")
    );
    assert_eq!(
        message_metadata.0["groupParticipation"]["enforcedBy"],
        json!("runtime-controller")
    );

    let job_row = connection
        .query_one(
            "select id, payload from agent_jobs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?;
    let job_id: Uuid = job_row.get("id");
    let job_payload: PgJson<serde_json::Value> = job_row.get("payload");
    assert_eq!(
        job_payload.0["metadata"]["groupParticipation"]["decision"],
        json!("agent_evaluation")
    );
    assert_eq!(
        job_payload.0["metadata"]["managedAiBillingDeferred"],
        json!(true)
    );
    assert_eq!(job_payload.0["metadata"]["managedAiUsed"], json!(false));

    let prompt_row = connection
        .query_one(
            "select id, metadata from prompts where conversation_id = $1",
            &[&conversation_id],
        )
        .await?;
    let prompt_metadata: PgJson<serde_json::Value> = prompt_row.get("metadata");
    assert_eq!(prompt_metadata.0["aiAccessMode"], json!("managed"));
    assert_eq!(prompt_metadata.0["managedAiUsed"], json!(false));

    let ledger_count: i64 = connection
        .query_one(
            "select count(*)::bigint from org_credit_ledger where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(ledger_count, 0, "an undecided evaluation must not burn");

    connection
        .execute(
            "update agent_jobs set status = 'leased' where id = $1",
            &[&job_id],
        )
        .await?;
    drop(connection);

    let token = mint_agent_message_token(&config, &project_id)?;
    let status = post_agent_endpoint(
        &state,
        &token,
        "/agent/message",
        json!({ "job_id": job_id, "content": "NO_RESPONSE" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "the decline must succeed normally");

    let connection = pool.get().await?;
    // The noop test runtime provider records a controller runtime alert on the
    // run; only conversational assistant output matters here.
    let assistant_count: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1
               and role = 'assistant'
               and coalesce(metadata ->> 'kind', '') <> 'runtime_alert'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(assistant_count, 0, "the decline sentinel must be swallowed");

    let job_payload: PgJson<serde_json::Value> = connection
        .query_one("select payload from agent_jobs where id = $1", &[&job_id])
        .await?
        .get("payload");
    assert_eq!(
        job_payload.0["metadata"]["groupParticipation"]["decision"],
        json!("silent")
    );
    assert_eq!(
        job_payload.0["metadata"]["groupParticipation"]["reason"],
        json!("agent_declined")
    );
    assert_eq!(
        job_payload.0["metadata"]["groupParticipation"]["enforcedBy"],
        json!("runtime-controller")
    );
    let run_metadata: PgJson<serde_json::Value> = connection
        .query_one(
            "select metadata from runs where id = $1",
            &[&response.run_id.expect("run id")],
        )
        .await?
        .get("metadata");
    assert_eq!(
        run_metadata.0["groupParticipation"]["decision"],
        json!("silent")
    );

    let ledger_count: i64 = connection
        .query_one(
            "select count(*)::bigint from org_credit_ledger where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(ledger_count, 0, "a declined evaluation must burn nothing");
    let prompt_metadata: PgJson<serde_json::Value> = connection
        .query_one(
            "select metadata from prompts where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get("metadata");
    assert_eq!(prompt_metadata.0["managedAiUsed"], json!(false));
    drop(connection);

    let status = post_agent_endpoint(
        &state,
        &token,
        "/agent/complete",
        json!({ "job_id": job_id, "outcome": "succeeded" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let connection = pool.get().await?;
    let job_status: String = connection
        .query_one("select status from agent_jobs where id = $1", &[&job_id])
        .await?
        .get("status");
    assert_eq!(job_status, "completed");
    let run_status: String = connection
        .query_one(
            "select status from runs where id = $1",
            &[&response.run_id.expect("run id")],
        )
        .await?
        .get("status");
    assert_eq!(run_status, "success");
    let sentinel_rows: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1 and content = 'NO_RESPONSE'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(sentinel_rows, 0, "the sentinel must never be persisted");
    let conversational_assistant_rows: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1
               and role = 'assistant'
               and coalesce(metadata ->> 'kind', '') <> 'runtime_alert'
               and lower(coalesce(metadata ->> 'messageType', '')) <> 'token_usage'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(
        conversational_assistant_rows, 0,
        "completion after a streamed decline must not invent a placeholder"
    );
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &other_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn skill_mode_answered_evaluation_bills_on_first_visible_message() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping skill-mode billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &other_user_id,
        "Skill mode billing test",
    )
    .await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&org_id, &project_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "skill-mode-billing",
    );
    let state = build_test_state(pool.clone(), config.clone());

    let request = ambient_group_dispatch_request(&project_id, &conversation_id)?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process skill-mode billing dispatch", error))?;
    assert_eq!(response.status, "queued");

    let connection = pool.get().await?;
    let job_row = connection
        .query_one(
            "select id from agent_jobs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?;
    let job_id: Uuid = job_row.get("id");
    let prompt_id: Uuid = connection
        .query_one(
            "select id from prompts where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get("id");
    connection
        .execute(
            "update agent_jobs set status = 'leased' where id = $1",
            &[&job_id],
        )
        .await?;
    drop(connection);

    let token = mint_agent_message_token(&config, &project_id)?;
    let status = post_agent_endpoint(
        &state,
        &token,
        "/agent/message",
        json!({
            "job_id": job_id,
            "content": "The blue version keeps the contrast ratio above 4.5:1.",
            "message_type": "status",
            "metadata": {
                "kind": "agent_message",
                "event": {
                    "type": "item.completed",
                    "item": {
                        "type": "agent_message",
                        "text": "The blue version keeps the contrast ratio above 4.5:1."
                    }
                }
            }
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let connection = pool.get().await?;
    let assistant_count: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1
               and role = 'assistant'
               and coalesce(metadata ->> 'kind', '') <> 'runtime_alert'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(assistant_count, 1, "the answer must persist");

    let burn_row = connection
        .query_one(
            "select delta, idempotency_key from org_credit_ledger
             where project_id = $1 and reason = 'managed_ai_prompt'",
            &[&project_id],
        )
        .await?;
    assert_eq!(burn_row.get::<_, i32>("delta"), -1);
    assert_eq!(
        burn_row
            .get::<_, Option<String>>("idempotency_key")
            .as_deref(),
        Some(format!("managed-ai-prompt:{prompt_id}").as_str())
    );
    let prompt_metadata: PgJson<serde_json::Value> = connection
        .query_one("select metadata from prompts where id = $1", &[&prompt_id])
        .await?
        .get("metadata");
    assert_eq!(prompt_metadata.0["managedAiUsed"], json!(true));
    assert_eq!(prompt_metadata.0["aiAccessMode"], json!("managed"));
    let job_payload: PgJson<serde_json::Value> = connection
        .query_one("select payload from agent_jobs where id = $1", &[&job_id])
        .await?
        .get("payload");
    assert_eq!(job_payload.0["metadata"]["managedAiUsed"], json!(true));
    assert_eq!(
        job_payload.0["metadata"]["groupParticipation"]["decision"],
        json!("agent_evaluation"),
        "an answered evaluation records no decline"
    );
    drop(connection);

    // Declines are first-output-only: after a visible answer the sentinel is
    // an ordinary message and must persist verbatim.
    let status = post_agent_endpoint(
        &state,
        &token,
        "/agent/message",
        json!({
            "job_id": job_id,
            "content": "NO_RESPONSE",
            "message_type": "status",
            "metadata": {
                "kind": "agent_message",
                "event": {
                    "type": "item.completed",
                    "item": { "type": "agent_message", "text": "NO_RESPONSE" }
                }
            }
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let connection = pool.get().await?;
    let sentinel_rows: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1 and role = 'assistant' and content = 'NO_RESPONSE'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(
        sentinel_rows, 1,
        "a late NO_RESPONSE must persist once the run has spoken"
    );
    let burn_count: i64 = connection
        .query_one(
            "select count(*)::bigint from org_credit_ledger
             where project_id = $1 and reason = 'managed_ai_prompt'",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(burn_count, 1, "the deferred burn must land exactly once");
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &other_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn no_response_on_direct_turn_persists_as_a_normal_message() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping direct NO_RESPONSE test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Direct NO_RESPONSE test')",
                &[&org_id, &format!("direct-no-response-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner')",
                &[&org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Direct NO_RESPONSE project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64,
                     metadata, is_default
                 ) values (
                     $1, $2, 'openai_api_key', 'Direct NO_RESPONSE test',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, true
                 )",
                &[&credential_id, &owner_user_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "skill-mode-direct-no-response",
    );
    let state = build_test_state(pool.clone(), config.clone());

    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("@octo what does NO_RESPONSE mean in our skill?".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": ["octo"], "mentions": ["octo"] }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize direct dispatch", error))?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process direct dispatch", error))?;
    assert_eq!(response.status, "queued");

    let connection = pool.get().await?;
    let job_id: Uuid = connection
        .query_one(
            "select id from agent_jobs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get("id");
    connection
        .execute(
            "update agent_jobs set status = 'leased' where id = $1",
            &[&job_id],
        )
        .await?;
    drop(connection);

    let token = mint_agent_message_token(&config, &project_id)?;
    let status = post_agent_endpoint(
        &state,
        &token,
        "/agent/message",
        json!({ "job_id": job_id, "content": "NO_RESPONSE" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let connection = pool.get().await?;
    let sentinel_rows: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1 and role = 'assistant' and content = 'NO_RESPONSE'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(
        sentinel_rows, 1,
        "a direct answer is never swallowed, even when it matches the sentinel"
    );
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

async fn seed_custom_agent(
    pool: &PgPool,
    user_id: &Uuid,
    credential_id: &Uuid,
    agent_id: &Uuid,
    handle: &str,
    description: &str,
) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into user_credentials (
                 id, user_id, kind, label, nonce_b64, ciphertext_b64,
                 metadata, is_default
             ) values (
                 $1, $2, 'openai_api_key', 'Custom agent credential',
                 'test-nonce', 'test-ciphertext', '{}'::jsonb, false
             )",
            &[credential_id, user_id],
        )
        .await?;
    connection
        .execute(
            "insert into user_agents (
                 id, user_id, credential_id, provider, handle, display_name,
                 description, avatar_seed
             ) values ($1, $2, $3, 'openai', $4, initcap($4), $5, $4)",
            &[agent_id, user_id, credential_id, &handle, &description],
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn skill_mode_multi_ai_ambient_turn_evaluates_every_agent_and_swallows_custom_decline(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping multi-AI skill-mode test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    let agent_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &other_user_id,
        "Multi-AI skill mode test",
    )
    .await?;
    seed_custom_agent(
        &pool,
        &owner_user_id,
        &credential_id,
        &agent_id,
        "reviewer",
        "Reviews frontend changes",
    )
    .await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "skill-mode-multi-ai",
    );
    let state = build_test_state(pool.clone(), config.clone());

    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Should we keep the blue version?".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": ["octo", "reviewer"], "mentions": [] }
        })),
        conversation_metadata: Some(json!({ "visibility": "public" })),
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize multi-AI ambient dispatch", error))?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process multi-AI ambient dispatch", error))?;
    assert_eq!(
        response.status, "queued",
        "an ambient multi-AI turn must dispatch evaluations"
    );

    let connection = pool.get().await?;
    let job_rows = connection
        .query(
            "select id, run_id, credential_id, payload from agent_jobs
             where conversation_id = $1
             order by created_at asc, id asc",
            &[&conversation_id],
        )
        .await?;
    assert_eq!(
        job_rows.len(),
        2,
        "every ambient-active agent must receive an evaluation job"
    );

    let mut octo_job: Option<(Uuid, serde_json::Value)> = None;
    let mut reviewer_job: Option<(Uuid, Uuid, Option<Uuid>, serde_json::Value)> = None;
    for row in &job_rows {
        let job_id: Uuid = row.get("id");
        let run_id: Uuid = row.get("run_id");
        let job_credential_id: Option<Uuid> = row.get("credential_id");
        let payload: PgJson<serde_json::Value> = row.get("payload");
        let payload = payload.0;
        assert_eq!(
            payload["metadata"]["groupParticipation"]["decision"],
            json!("agent_evaluation"),
            "every evaluation job must carry the server-stamped marker"
        );
        assert_eq!(
            payload["metadata"]["groupParticipation"]["reason"],
            json!("skill_mode_ambient")
        );
        let participants = payload["metadata"]["groupAiParticipants"]
            .as_array()
            .expect("evaluation jobs carry the AI participant roster")
            .clone();
        assert_eq!(
            participants.len(),
            2,
            "the roster lists every AI participant"
        );
        match payload["metadata"]["agent"]["handle"].as_str() {
            Some("octo") => octo_job = Some((job_id, payload)),
            Some("reviewer") => reviewer_job = Some((job_id, run_id, job_credential_id, payload)),
            other => panic!("unexpected agent handle on evaluation job: {other:?}"),
        }
    }

    let (_octo_job_id, octo_payload) = octo_job.expect("octo evaluation job");
    assert_eq!(
        octo_payload["metadata"]["managedAiBillingDeferred"],
        json!(true),
        "the managed default agent defers its flat burn"
    );
    assert_eq!(octo_payload["metadata"]["managedAiUsed"], json!(false));
    let octo_prompt = octo_payload["prompt_text"].as_str().expect("octo prompt");
    assert!(
        octo_prompt.contains("@octo") && octo_prompt.contains("@reviewer"),
        "the delivered turn addresses octo and lists the reviewer peer: {octo_prompt}"
    );
    assert!(
        octo_prompt.contains("Reviews frontend changes"),
        "the peer listing includes the reviewer description: {octo_prompt}"
    );

    let (reviewer_job_id, reviewer_run_id, reviewer_credential, reviewer_payload) =
        reviewer_job.expect("reviewer evaluation job");
    assert_eq!(
        reviewer_credential,
        Some(credential_id),
        "the custom agent evaluation runs on its own credential"
    );
    assert_eq!(
        reviewer_payload["metadata"]["managedAiBillingDeferred"],
        json!(false),
        "a BYOC evaluation has no flat managed burn to defer"
    );
    assert_eq!(reviewer_payload["metadata"]["aiAccessMode"], json!("byoc"));
    assert_eq!(reviewer_payload["metadata"]["managedAiUsed"], json!(false));
    let reviewer_prompt = reviewer_payload["prompt_text"]
        .as_str()
        .expect("reviewer prompt");
    assert!(
        reviewer_prompt.contains("@reviewer") && reviewer_prompt.contains("@octo"),
        "the delivered turn addresses the reviewer and lists octo: {reviewer_prompt}"
    );

    let ledger_count: i64 = connection
        .query_one(
            "select count(*)::bigint from org_credit_ledger where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(ledger_count, 0, "undecided evaluations must not burn");

    connection
        .execute(
            "update agent_jobs set status = 'leased' where id = $1",
            &[&reviewer_job_id],
        )
        .await?;
    drop(connection);

    let token = mint_agent_message_token(&config, &project_id)?;
    let status = post_agent_endpoint(
        &state,
        &token,
        "/agent/message",
        json!({ "job_id": reviewer_job_id, "content": "NO_RESPONSE" }),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "the custom agent decline must succeed normally"
    );

    let connection = pool.get().await?;
    let assistant_count: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1
               and role = 'assistant'
               and coalesce(metadata ->> 'kind', '') <> 'runtime_alert'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(
        assistant_count, 0,
        "the custom agent decline sentinel must be swallowed"
    );
    let reviewer_payload: PgJson<serde_json::Value> = connection
        .query_one(
            "select payload from agent_jobs where id = $1",
            &[&reviewer_job_id],
        )
        .await?
        .get("payload");
    assert_eq!(
        reviewer_payload.0["metadata"]["groupParticipation"]["decision"],
        json!("silent")
    );
    assert_eq!(
        reviewer_payload.0["metadata"]["groupParticipation"]["reason"],
        json!("agent_declined")
    );
    let reviewer_run_metadata: PgJson<serde_json::Value> = connection
        .query_one(
            "select metadata from runs where id = $1",
            &[&reviewer_run_id],
        )
        .await?
        .get("metadata");
    assert_eq!(
        reviewer_run_metadata.0["groupParticipation"]["decision"],
        json!("silent"),
        "the custom agent decline must be recorded on its run"
    );
    let ledger_count: i64 = connection
        .query_one(
            "select count(*)::bigint from org_credit_ledger where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(ledger_count, 0, "a declined BYOC evaluation burns nothing");
    drop(connection);

    let status = post_agent_endpoint(
        &state,
        &token,
        "/agent/complete",
        json!({ "job_id": reviewer_job_id, "outcome": "succeeded" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let connection = pool.get().await?;
    let job_status: String = connection
        .query_one(
            "select status from agent_jobs where id = $1",
            &[&reviewer_job_id],
        )
        .await?
        .get("status");
    assert_eq!(job_status, "completed");
    let sentinel_rows: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
             where conversation_id = $1 and content = 'NO_RESPONSE'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(sentinel_rows, 0, "the sentinel must never be persisted");
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &other_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn explicit_custom_agent_mention_stays_a_direct_dispatch() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping direct custom-agent mention test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    let agent_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &other_user_id,
        "Direct custom mention test",
    )
    .await?;
    seed_custom_agent(
        &pool,
        &owner_user_id,
        &credential_id,
        &agent_id,
        "reviewer",
        "Reviews frontend changes",
    )
    .await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "skill-mode-direct-custom-mention",
    );
    let state = build_test_state(pool.clone(), config.clone());

    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("@reviewer please check the header spacing".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": ["octo", "reviewer"], "mentions": ["reviewer"] }
        })),
        conversation_metadata: Some(json!({ "visibility": "public" })),
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize direct custom mention", error))?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process direct custom mention", error))?;
    assert_eq!(response.status, "queued");

    let connection = pool.get().await?;
    let job_rows = connection
        .query(
            "select payload from agent_jobs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?;
    assert_eq!(
        job_rows.len(),
        1,
        "an explicit mention dispatches only the mentioned agent"
    );
    let payload: PgJson<serde_json::Value> = job_rows[0].get("payload");
    assert_eq!(payload.0["metadata"]["agent"]["handle"], json!("reviewer"));
    assert!(
        payload.0["metadata"].get("groupParticipation").is_none(),
        "a direct dispatch must not carry the evaluation marker"
    );
    let prompt_text = payload.0["prompt_text"].as_str().expect("prompt text");
    assert!(
        !prompt_text.starts_with("[Ambient group turn"),
        "a direct dispatch is delivered without the evaluation wrapper: {prompt_text}"
    );
    let message_metadata: PgJson<serde_json::Value> = connection
        .query_one(
            "select metadata from conversation_messages
             where conversation_id = $1 and role = 'user'",
            &[&conversation_id],
        )
        .await?
        .get("metadata");
    assert!(
        message_metadata.0.get("groupParticipation").is_none(),
        "a direct mention records without a participation marker"
    );
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &other_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_retry_does_not_replace_an_awaited_active_octo_answer() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping awaited Octo retry test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let original_run_id = Uuid::new_v4();
    let original_job_id = Uuid::new_v4();
    let original_message_id = Uuid::new_v4();
    let client_message_id = Uuid::new_v4().to_string();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Awaited Octo retry test')",
                &[&org_id, &format!("awaited-octo-retry-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder')",
                &[&org_id, &owner_user_id, &other_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Awaited Octo retry project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &other_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $2, $3, 'prompt', 'in_progress')",
                &[&original_run_id, &project_id, &conversation_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata, created_by
                 ) values ($1, $2, $3, $4, 'user', 'What is 1+1?', '{}'::jsonb, $5)",
                &[
                    &original_message_id,
                    &conversation_id,
                    &project_id,
                    &original_run_id,
                    &owner_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into agent_jobs (
                     id, project_id, run_id, conversation_id, intent, status, payload, priority
                 ) values ($1, $2, $3, $4, 'feature', 'leased', $5, 100)",
                &[
                    &original_job_id,
                    &project_id,
                    &original_run_id,
                    &conversation_id,
                    &PgJson(json!({
                        "metadata": { "agent": { "handle": "octo" } }
                    })),
                ],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-awaited-octo-retry",
        ),
    );
    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("1+1=3".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": client_message_id,
            "agentSelection": { "active": ["octo"], "mentions": [] }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize awaited Octo retry", error))?;
    let context = RequestContext {
        user_id: Some(other_user_id),
        is_service_role: false,
        scoped_claims: None,
    };

    let first = dispatch::process_dispatch_prompt(&state, &context, request.clone())
        .await
        .map_err(|error| controller_error("process awaited Octo message", error))?;
    let retry = dispatch::process_dispatch_prompt(&state, &context, request.clone())
        .await
        .map_err(|error| controller_error("retry awaited Octo message", error))?;
    assert_eq!(first.status, "recorded");
    assert_eq!(retry.status, "recorded");
    assert!(first.run_id.is_none());
    assert!(retry.run_id.is_none());

    let mut changed_content_request = request.clone();
    changed_content_request.prompt_text = "1+1=2".to_string();
    let changed_content_error =
        dispatch::process_dispatch_prompt(&state, &context, changed_content_request)
            .await
            .expect_err("the same author cannot reuse a client id for different content");
    assert_eq!(changed_content_error.0, StatusCode::CONFLICT);

    let different_author_error = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .expect_err("another participant cannot reuse a visible client message id");
    assert_eq!(different_author_error.0, StatusCode::CONFLICT);

    let connection = pool.get().await?;
    let retried_message = connection
        .query_one(
            "select count(*)::bigint as message_count,
                    max(metadata #>> '{groupParticipation,coverage}') as coverage,
                    max(metadata #>> '{groupParticipation,enforcedBy}') as enforced_by
             from conversation_messages
             where conversation_id = $1
               and coalesce(
                     metadata->>'clientMessageId',
                     metadata#>>'{prompt_metadata,clientMessageId}'
                   ) = $2",
            &[&conversation_id, &client_message_id],
        )
        .await?;
    assert_eq!(retried_message.get::<_, i64>("message_count"), 1);
    assert_eq!(
        retried_message
            .get::<_, Option<String>>("coverage")
            .as_deref(),
        Some("await_active_octo")
    );
    assert_eq!(
        retried_message
            .get::<_, Option<String>>("enforced_by")
            .as_deref(),
        Some("runtime-controller")
    );
    let run_count: i64 = connection
        .query_one(
            "select count(*)::bigint from runs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get(0);
    let job_count: i64 = connection
        .query_one(
            "select count(*)::bigint from agent_jobs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(run_count, 1, "retry must not create a correction run");
    assert_eq!(job_count, 1, "retry must keep only the original Octo job");
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &other_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_strips_forged_group_participation_marker_on_octo_turns(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping forged participation marker test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    let client_message_id = Uuid::new_v4().to_string();
    ensure_test_user(&pool, &owner_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Forged participation test')",
                &[&org_id, &format!("forged-participation-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner')",
                &[&org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Forged participation project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64,
                     metadata, is_default
                 ) values (
                     $1, $2, 'openai_api_key', 'Forged participation test',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, true
                 )",
                &[&credential_id, &owner_user_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-forged-participation-marker",
        ),
    );
    let forged_marker = json!({
        "decision": "silent",
        "enforcedBy": "runtime-controller"
    });
    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("@octo what is 1+1?".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": client_message_id,
            "agentSelection": { "active": ["octo"], "mentions": ["octo"] },
            "groupParticipation": forged_marker.clone(),
            "group_participation": forged_marker.clone(),
            "prompt_metadata": { "groupParticipation": forged_marker.clone() }
        })),
        conversation_metadata: Some(json!({ "visibility": "public" })),
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize forged marker dispatch", error))?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process forged marker dispatch", error))?;

    assert_eq!(response.status, "queued");
    assert!(
        response.run_id.is_some(),
        "the explicit @octo turn must still dispatch"
    );

    let connection = pool.get().await?;
    let message = connection
        .query_one(
            "select run_id, metadata
             from conversation_messages
             where conversation_id = $1 and role = 'user'",
            &[&conversation_id],
        )
        .await?;
    assert_eq!(message.get::<_, Option<Uuid>>("run_id"), response.run_id);
    let message_metadata: PgJson<serde_json::Value> = message.get("metadata");
    assert!(message_metadata.0.get("groupParticipation").is_none());
    assert!(message_metadata.0.get("group_participation").is_none());
    assert!(message_metadata.0["prompt_metadata"]
        .get("groupParticipation")
        .is_none());
    assert!(message_metadata.0["prompt_metadata"]
        .get("group_participation")
        .is_none());
    assert!(message_metadata.0["prompt_metadata"]["prompt_metadata"]
        .get("groupParticipation")
        .is_none());
    let prompt_row = connection
        .query_one(
            "select metadata from prompts where conversation_id = $1",
            &[&conversation_id],
        )
        .await?;
    let prompt_metadata: PgJson<serde_json::Value> = prompt_row.get("metadata");
    assert!(prompt_metadata.0.get("groupParticipation").is_none());
    assert!(prompt_metadata.0.get("group_participation").is_none());
    assert!(prompt_metadata.0["prompt_metadata"]
        .get("groupParticipation")
        .is_none());
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_reuses_recorded_message_row_for_non_silent_dispatch() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping record-then-dispatch reuse test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    let recorded_message_id = Uuid::new_v4();
    let client_message_id = Uuid::new_v4().to_string();
    let prompt_text = "@octo what is 2+2?";
    ensure_test_user(&pool, &owner_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Record-then-dispatch reuse test')",
                &[&org_id, &format!("record-dispatch-reuse-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner')",
                &[&org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Record-then-dispatch project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64,
                     metadata, is_default
                 ) values (
                     $1, $2, 'openai_api_key', 'Record-then-dispatch reuse test',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, true
                 )",
                &[&credential_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, role, content, metadata, created_by
                 ) values ($1, $2, $3, 'user', $4, $5::jsonb, $6)",
                &[
                    &recorded_message_id,
                    &conversation_id,
                    &project_id,
                    &prompt_text,
                    &PgJson(json!({ "clientMessageId": client_message_id })),
                    &owner_user_id,
                ],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-record-then-dispatch-reuse",
        ),
    );
    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt_text.to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": client_message_id,
            "agentSelection": { "active": ["octo"], "mentions": ["octo"] }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize record-then-dispatch request", error))?;
    let context = RequestContext {
        user_id: Some(owner_user_id),
        is_service_role: false,
        scoped_claims: None,
    };
    let response = dispatch::process_dispatch_prompt(&state, &context, request.clone())
        .await
        .map_err(|error| controller_error("process record-then-dispatch prompt", error))?;
    assert_eq!(response.status, "queued");
    assert!(response.run_id.is_some());

    let connection = pool.get().await?;
    let message_count: i64 = connection
        .query_one(
            "select count(*)::bigint
             from conversation_messages
             where conversation_id = $1
               and coalesce(
                     metadata->>'clientMessageId',
                     metadata#>>'{prompt_metadata,clientMessageId}'
                   ) = $2",
            &[&conversation_id, &client_message_id],
        )
        .await?
        .get(0);
    assert_eq!(
        message_count, 1,
        "dispatch must reuse the recorded user message row"
    );
    let message = connection
        .query_one(
            "select id, prompt_id, run_id
             from conversation_messages
             where conversation_id = $1 and role = 'user'",
            &[&conversation_id],
        )
        .await?;
    assert_eq!(message.get::<_, Uuid>("id"), recorded_message_id);
    assert_eq!(message.get::<_, Option<Uuid>>("run_id"), response.run_id);
    assert_eq!(
        message.get::<_, Option<Uuid>>("prompt_id"),
        response.prompt_id
    );
    drop(connection);

    let retry = dispatch::process_dispatch_prompt(&state, &context, request)
        .await
        .map_err(|error| controller_error("retry record-then-dispatch prompt", error))?;
    assert_eq!(retry.run_id, response.run_id);
    let connection = pool.get().await?;
    // Background provisioning may append controller assistant notices, so
    // only the human turn is counted.
    let retried_count: i64 = connection
        .query_one(
            "select count(*)::bigint
             from conversation_messages
             where conversation_id = $1 and role = 'user'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(retried_count, 1);
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_republishes_silent_marker_for_previously_recorded_message(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping silent marker republish test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let recorded_message_id = Uuid::new_v4();
    let client_message_id = Uuid::new_v4().to_string();
    // Correct arithmetic is the surviving mechanically-silent classification:
    // it records without a job and must republish the silent marker onto a
    // previously recorded row.
    let prompt_text = "1 + 1 = 2";
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Silent republish test')",
                &[&org_id, &format!("silent-republish-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder')",
                &[&org_id, &owner_user_id, &other_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Silent republish project', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &other_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, role, content, metadata, created_by
                 ) values ($1, $2, $3, 'user', $4, $5::jsonb, $6)",
                &[
                    &recorded_message_id,
                    &conversation_id,
                    &project_id,
                    &prompt_text,
                    &PgJson(json!({ "clientMessageId": client_message_id })),
                    &owner_user_id,
                ],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-silent-marker-republish",
        ),
    );
    let mut events = state.events.subscribe();
    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt_text.to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": client_message_id,
            "agentSelection": { "active": ["octo"], "mentions": [] }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize silent republish dispatch", error))?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process silent republish dispatch", error))?;

    assert_eq!(response.status, "recorded");
    assert!(response.run_id.is_none());

    let connection = pool.get().await?;
    let message = connection
        .query_one(
            "select id, metadata
             from conversation_messages
             where conversation_id = $1 and role = 'user'",
            &[&conversation_id],
        )
        .await?;
    assert_eq!(message.get::<_, Uuid>("id"), recorded_message_id);
    let message_metadata: PgJson<serde_json::Value> = message.get("metadata");
    assert_eq!(
        message_metadata.0["groupParticipation"]["decision"],
        json!("silent")
    );
    assert_eq!(
        message_metadata.0["groupParticipation"]["enforcedBy"],
        json!("runtime-controller")
    );
    drop(connection);

    let message_event = loop {
        let event = timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timed out waiting for republished message event"))??;
        if event.kind == "conversation.message_created"
            && event.conversation_id == Some(conversation_id)
        {
            break event;
        }
    };
    assert_eq!(message_event.data["id"], json!(recorded_message_id));
    assert_eq!(
        message_event.data["metadata"]["groupParticipation"]["decision"],
        json!("silent")
    );
    assert_eq!(
        message_event.data["metadata"]["groupParticipation"]["enforcedBy"],
        json!("runtime-controller")
    );

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &other_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn group_participation_job_lock_fences_human_octo_answer_races() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping human/Octo answer race test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    #[derive(Clone, Copy)]
    struct ArithmeticTurn {
        conversation_id: Uuid,
        message_id: Uuid,
        run_id: Uuid,
        job_id: Uuid,
    }

    async fn seed_arithmetic_turn(
        pool: &PgPool,
        project_id: Uuid,
    ) -> anyhow::Result<ArithmeticTurn> {
        let turn = ArithmeticTurn {
            conversation_id: Uuid::new_v4(),
            message_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
        };
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversations (id, project_id, metadata, visibility)
                 values ($1, $2, '{}'::jsonb, 'public')",
                &[&turn.conversation_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $2, $3, 'prompt', 'in_progress')",
                &[&turn.run_id, &project_id, &turn.conversation_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata
                 ) values ($1, $2, $3, $4, 'user', 'What is 1+1?', '{}'::jsonb)",
                &[
                    &turn.message_id,
                    &turn.conversation_id,
                    &project_id,
                    &turn.run_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into agent_jobs (
                     id, project_id, run_id, conversation_id, intent, status, payload, priority
                 ) values ($1, $2, $3, $4, 'feature', 'leased', $5, 100)",
                &[
                    &turn.job_id,
                    &project_id,
                    &turn.run_id,
                    &turn.conversation_id,
                    &PgJson(json!({
                        "metadata": { "agent": { "handle": "octo" } }
                    })),
                ],
            )
            .await?;
        Ok(turn)
    }

    fn coverage(
        turn: ArithmeticTurn,
        action: crate::group_participation::ArithmeticCoverageAction,
    ) -> crate::group_participation::ArithmeticCoverage {
        crate::group_participation::ArithmeticCoverage {
            action,
            message_id: turn.message_id,
            run_id: turn.run_id,
            job_id: turn.job_id,
        }
    }

    async fn wait_for_backend_lock(
        pool: &PgPool,
        backend_pid: i32,
        label: &str,
    ) -> anyhow::Result<()> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let connection = pool.get().await?;
            let row = connection
                .query_opt(
                    "select wait_event_type, wait_event
                     from pg_stat_activity
                     where pid = $1",
                    &[&backend_pid],
                )
                .await?;
            if row.as_ref().is_some_and(|row| {
                row.get::<_, Option<String>>("wait_event_type").as_deref() == Some("Lock")
            }) {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                let wait_event = row.and_then(|row| row.get::<_, Option<String>>("wait_event"));
                anyhow::bail!(
                    "{label}: backend {backend_pid} did not reach a lock wait (last event: {wait_event:?})"
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    let project_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    // If the human answer owns the job-row lock first, the pending Octo work is
    // canceled together with its run so no redundant answer can remain active.
    let human_first = seed_arithmetic_turn(&pool, project_id).await?;
    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let canceled = crate::group_participation::cancel_covered_default_octo_job(
            &transaction,
            &project_id,
            &human_first.conversation_id,
            coverage(
                human_first,
                crate::group_participation::ArithmeticCoverageAction::CancelActiveOcto,
            ),
        )
        .await
        .map_err(|error| controller_error("cancel human-covered Octo answer", error))?;
        assert!(canceled);
        transaction.commit().await?;
    }
    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "select job.status as job_status,
                        job.summary,
                        run.status as run_status,
                        run.last_message
                 from agent_jobs job
                 join runs run on run.id = job.run_id
                 where job.id = $1",
                &[&human_first.job_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("job_status"), "canceled");
        assert_eq!(row.get::<_, String>("run_status"), "canceled");
        assert_eq!(
            row.get::<_, Option<String>>("summary").as_deref(),
            Some(crate::group_participation::HUMAN_ANSWER_CANCELLATION_REASON)
        );
        assert_eq!(
            row.get::<_, Option<String>>("last_message").as_deref(),
            Some(crate::group_participation::HUMAN_ANSWER_CANCELLATION_REASON)
        );
    }

    // In the inverse ordering, `/agent/message` owns the same row lock and
    // persists the correct controller-authored answer before releasing it. The
    // waiting human-answer cancellation must recheck delivery after acquiring
    // the lock and leave both the already-visible answer and its job intact.
    let octo_first = seed_arithmetic_turn(&pool, project_id).await?;
    let mut answer_connection = pool.get().await?;
    let answer_transaction = answer_connection.transaction().await?;
    answer_transaction
        .query_one(
            "select id from agent_jobs where id = $1 for update",
            &[&octo_first.job_id],
        )
        .await?;

    let cancel_pool = pool.clone();
    let cancel_barrier = Arc::new(tokio::sync::Barrier::new(2));
    let cancel_task_barrier = cancel_barrier.clone();
    let (cancel_pid_sender, cancel_pid_receiver) = tokio::sync::oneshot::channel();
    let mut cancel_task = tokio::spawn(async move {
        let mut connection = cancel_pool.get().await?;
        let transaction = connection.transaction().await?;
        let backend_pid: i32 = transaction
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        let _ = cancel_pid_sender.send(backend_pid);
        cancel_task_barrier.wait().await;
        let canceled = crate::group_participation::cancel_covered_default_octo_job(
            &transaction,
            &project_id,
            &octo_first.conversation_id,
            coverage(
                octo_first,
                crate::group_participation::ArithmeticCoverageAction::CancelActiveOcto,
            ),
        )
        .await
        .map_err(|error| controller_error("cancel after delivered Octo answer", error))?;
        transaction.commit().await?;
        Ok::<_, anyhow::Error>(canceled)
    });
    let cancel_backend_pid = cancel_pid_receiver.await?;
    cancel_barrier.wait().await;
    wait_for_backend_lock(&pool, cancel_backend_pid, "human-answer cancellation").await?;
    assert!(
        timeout(std::time::Duration::from_millis(20), &mut cancel_task)
            .await
            .is_err(),
        "human-answer cancellation must wait for Octo's delivery lock"
    );

    answer_transaction
        .execute(
            "insert into conversation_messages (
                 id, conversation_id, project_id, run_id, role, content, metadata, created_by
             ) values ($1, $2, $3, $4, 'assistant', 'The answer is 2.', '{}'::jsonb, null)",
            &[
                &Uuid::new_v4(),
                &octo_first.conversation_id,
                &project_id,
                &octo_first.run_id,
            ],
        )
        .await?;
    answer_transaction.commit().await?;

    let canceled = timeout(std::time::Duration::from_secs(2), cancel_task).await???;
    assert!(
        !canceled,
        "a delivered correct Octo answer must defeat stale cancellation"
    );
    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "select job.status as job_status, run.status as run_status
                 from agent_jobs job
                 join runs run on run.id = job.run_id
                 where job.id = $1",
                &[&octo_first.job_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("job_status"), "leased");
        assert_eq!(row.get::<_, String>("run_status"), "in_progress");
    }

    // Revalidation begins with the stale preflight result `AwaitActiveOcto`,
    // then waits on the exact job row while it crosses a terminal boundary.
    // Only a successful completion with a verified controller answer may keep
    // the follow-up human-only; every other terminal result releases the turn
    // for one replacement correction.
    for (label, job_status, answer, expected_action) in [
        (
            "completed with verified answer",
            "completed",
            Some(("The answer is 2.", true)),
            Some(crate::group_participation::ArithmeticCoverageAction::ReuseCompletedOcto),
        ),
        ("completed without answer", "completed", None, None),
        (
            "completed with wrong answer",
            "completed",
            Some(("The answer is 3.", true)),
            None,
        ),
        (
            "completed with human-authored assistant-shaped answer",
            "completed",
            Some(("The answer is 2.", false)),
            None,
        ),
        ("failed", "failed", None, None),
        ("canceled", "canceled", None, None),
        ("expired", "expired", None, None),
    ] {
        let turn = seed_arithmetic_turn(&pool, project_id).await?;
        let mut terminal_connection = pool.get().await?;
        let terminal_transaction = terminal_connection.transaction().await?;
        terminal_transaction
            .query_one(
                "select id from agent_jobs where id = $1 for update",
                &[&turn.job_id],
            )
            .await?;

        let revalidation_pool = pool.clone();
        let revalidation_barrier = Arc::new(tokio::sync::Barrier::new(2));
        let task_barrier = revalidation_barrier.clone();
        let (revalidation_pid_sender, revalidation_pid_receiver) = tokio::sync::oneshot::channel();
        let mut revalidation_task = tokio::spawn(async move {
            let mut connection = revalidation_pool.get().await?;
            let transaction = connection.transaction().await?;
            let backend_pid: i32 = transaction
                .query_one("select pg_backend_pid()", &[])
                .await?
                .get(0);
            let _ = revalidation_pid_sender.send(backend_pid);
            task_barrier.wait().await;
            let revalidated = crate::group_participation::revalidate_awaited_default_octo_job(
                &transaction,
                &project_id,
                &turn.conversation_id,
                coverage(
                    turn,
                    crate::group_participation::ArithmeticCoverageAction::AwaitActiveOcto,
                ),
            )
            .await
            .map_err(|error| controller_error("revalidate terminal Octo answer", error))?;
            transaction.commit().await?;
            Ok::<_, anyhow::Error>(revalidated.map(|coverage| coverage.action))
        });
        let revalidation_backend_pid = revalidation_pid_receiver.await?;
        revalidation_barrier.wait().await;
        wait_for_backend_lock(
            &pool,
            revalidation_backend_pid,
            &format!("{label}: revalidation"),
        )
        .await?;
        assert!(
            timeout(std::time::Duration::from_millis(20), &mut revalidation_task)
                .await
                .is_err(),
            "{label}: revalidation must wait for the terminal job transition"
        );

        terminal_transaction
            .execute(
                "update agent_jobs
                 set status = $2,
                     outcome = $2,
                     completed_at = now()
                 where id = $1",
                &[&turn.job_id, &job_status],
            )
            .await?;
        let run_status = match job_status {
            "completed" => "success",
            "canceled" => "canceled",
            _ => "failed",
        };
        terminal_transaction
            .execute(
                "update runs set status = $2 where id = $1",
                &[&turn.run_id, &run_status],
            )
            .await?;
        if let Some((content, controller_authored)) = answer {
            let created_by = (!controller_authored).then(Uuid::new_v4);
            terminal_transaction
                .execute(
                    "insert into conversation_messages (
                         id, conversation_id, project_id, run_id, role, content, metadata, created_by
                     ) values ($1, $2, $3, $4, 'assistant', $5, '{}'::jsonb, $6)",
                    &[
                        &Uuid::new_v4(),
                        &turn.conversation_id,
                        &project_id,
                        &turn.run_id,
                        &content,
                        &created_by,
                    ],
                )
                .await?;
        }
        terminal_transaction.commit().await?;

        let actual_action =
            timeout(std::time::Duration::from_secs(2), revalidation_task).await???;
        assert_eq!(actual_action, expected_action, "{label}");
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_dedupes_nested_client_message_id() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping dispatch idempotency test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let client_message_id = format!("goal-continuation:{}:{}", Uuid::new_v4(), Uuid::new_v4());
    let prompt = "Continue goal: count to 3";

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-client-message-idempotency",
        ),
    );
    let context = RequestContext {
        user_id: None,
        is_service_role: true,
        scoped_claims: None,
    };

    let build_request = || DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt.to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": client_message_id,
            "goalContinuation": {
                "triggerRunId": Uuid::new_v4().to_string(),
                "turn": 1
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    };
    let build_expected_idle_request = || {
        let mut request = dispatch::normalize_dispatch_request(build_request())
            .map_err(|error| controller_error("normalize expected-idle dispatch", error))?;
        request.expected_lane_idle = true;
        Ok::<_, anyhow::Error>(request)
    };

    let first = dispatch::process_dispatch_prompt(&state, &context, build_expected_idle_request()?)
        .await
        .map_err(|error| controller_error("process first dispatch prompt", error))?;
    let second =
        dispatch::process_dispatch_prompt(&state, &context, build_expected_idle_request()?)
            .await
            .map_err(|error| controller_error("process second dispatch prompt", error))?;

    assert_eq!(second.run_id, first.run_id);
    assert_eq!(second.prompt_id, first.prompt_id);

    let connection = pool.get().await?;
    let message_count: i64 = connection
        .query_one(
            "SELECT count(*)
             FROM conversation_messages
             WHERE conversation_id = $1
               AND coalesce(
                     metadata->>'clientMessageId',
                     metadata->>'client_message_id',
                     metadata#>>'{prompt_metadata,clientMessageId}',
                     metadata#>>'{prompt_metadata,client_message_id}',
                     metadata#>>'{promptMetadata,clientMessageId}',
                     metadata#>>'{promptMetadata,client_message_id}'
                   ) = $2",
            &[&conversation_id, &client_message_id],
        )
        .await?
        .get(0);
    let run_count: i64 = connection
        .query_one(
            "SELECT count(*)
             FROM runs
             WHERE conversation_id = $1
               AND metadata->>'clientMessageId' = $2",
            &[&conversation_id, &client_message_id],
        )
        .await?
        .get(0);
    let job_count: i64 = connection
        .query_one(
            "SELECT count(*) FROM agent_jobs WHERE conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get(0);
    let queue_count: i64 = connection
        .query_one(
            "SELECT count(*) FROM conversation_send_queue WHERE conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get(0);

    assert_eq!(message_count, 1);
    assert_eq!(run_count, 1);
    assert_eq!(job_count, 1);
    assert_eq!(queue_count, 0, "an idempotent retry must not autoqueue");

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_persists_canonical_shared_browser_authority() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping Shared Browser dispatch authority test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, capabilities,
                     idle_ttl_seconds, last_seen_at, updated_at
                 ) VALUES ($1, $2, 'runtime', 'ready', $3, 600, now(), now())",
                &[
                    &runtime_id,
                    &project_id,
                    &PgJson(json!({ "agent": true, "origin": true })),
                ],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-shared-browser-authority",
        ),
    );
    let normalized = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Click the visible Continue button.".to_string()),
        intent: Some("browser".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "browserTransport": "shared",
            "browserConsentVersion": 1,
            "browserRuntimeId": runtime_id,
            "runtimeExpectations": {
                "workspaceFileChanges": false,
                "commandExecution": false,
                "browserExecution": true
            },
            "agentSelection": {
                "active": ["octo"],
                "mentions": ["octo"]
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: Some(runtime_id.to_string()),
        runtime_display_name: None,
        prefer_runtime: Some(true),
    })
    .map_err(|error| controller_error("normalize Shared Browser dispatch", error))?;
    let context = RequestContext {
        user_id: None,
        is_service_role: true,
        scoped_claims: None,
    };
    let (status, error) = dispatch::process_dispatch_prompt(&state, &context, normalized.clone())
        .await
        .expect_err("non-managed runtime must reject Shared Browser dispatch");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(error.0.message.contains("managed Instafy Cloud"));

    {
        let connection = pool.get().await?;
        let job_count: i64 = connection
            .query_one(
                "SELECT count(*) FROM agent_jobs WHERE project_id = $1",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(job_count, 0);
        let cloud_looking_custom_capabilities = json!({ "agent": true, "origin": true });
        connection
            .execute(
                "UPDATE runtimes
                 SET provider = 'instafy-cloud-custom', capabilities = $2
                 WHERE id = $1",
                &[&runtime_id, &PgJson(cloud_looking_custom_capabilities)],
            )
            .await?;
    }

    let (status, error) = dispatch::process_dispatch_prompt(&state, &context, normalized.clone())
        .await
        .expect_err("cloud-looking custom runtime must reject Shared Browser dispatch");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(error.0.message.contains("managed Instafy Cloud"));

    {
        let connection = pool.get().await?;
        let job_count: i64 = connection
            .query_one(
                "SELECT count(*) FROM agent_jobs WHERE project_id = $1",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(job_count, 0);
        connection
            .execute(
                "UPDATE runtimes
                 SET provider = 'instafy-cloud', capabilities = $2
                 WHERE id = $1",
                &[
                    &runtime_id,
                    &PgJson(json!({
                        "agent": true,
                        "origin": true,
                        "_instafySharedBrowserAgentConsent": { "version": 1 }
                    })),
                ],
            )
            .await?;
    }

    let response = dispatch::process_dispatch_prompt(&state, &context, normalized)
        .await
        .map_err(|error| controller_error("process Shared Browser dispatch", error))?;

    assert!(response.run_ids.is_none());
    assert!(response.job_ids.is_none());
    let connection = pool.get().await?;
    let row = connection
        .query_one(
            "SELECT target_runtime_id, payload->'metadata' AS metadata
             FROM agent_jobs
             WHERE project_id = $1 AND prompt_id = $2",
            &[&project_id, &response.prompt_id],
        )
        .await?;
    assert_eq!(
        row.get::<_, Option<Uuid>>("target_runtime_id"),
        Some(runtime_id)
    );
    let metadata: serde_json::Value = row.get("metadata");
    assert_eq!(metadata["browserTransport"], "shared");
    assert_eq!(metadata["browserConsentVersion"], 1);
    assert_eq!(metadata["browserRuntimeId"], runtime_id.to_string());
    assert_eq!(metadata["writeIntent"], false);
    assert_eq!(metadata["writeScope"]["mode"], "read_only");
    assert_eq!(metadata["writeScope"]["ownedPaths"], json!([]));
    assert_eq!(
        metadata["runtimeExpectations"]["workspaceFileChanges"],
        false
    );
    assert_eq!(metadata["runtimeExpectations"]["commandExecution"], false);
    assert_eq!(
        metadata["runtimeExpectations"]["genericMcpToolExecution"],
        false
    );
    assert_eq!(metadata["runtimeExpectations"]["browserExecution"], true);
    assert_eq!(metadata["runtimeRouting"]["strategy"], "exact");
    assert_eq!(metadata["workspaceMode"], "shared_read");

    drop(connection);
    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_keeps_owned_personal_browser_runtime_pinned() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("Personal Browser dispatch pinning regression").await?;

    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;

    let mut capabilities = json!({
        "agent": true,
        "origin": true,
        "personalBrowser": {
            "enabled": true,
            "ownerUserId": user_id.to_string(),
        },
    });
    runtime::set_self_hosted_access_attestation(
        capabilities
            .as_object_mut()
            .expect("Personal Browser capabilities are an object"),
        user_id,
    );

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO organizations (id, slug, name)
                 VALUES ($1, $2, 'Personal Browser dispatch regression')",
                &[&org_id, &format!("personal-browser-dispatch-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO org_memberships (org_id, user_id, role)
                 VALUES ($1, $2, 'owner')",
                &[&org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO projects (
                     id, org_id, owner_user_id, project_type, status
                 ) VALUES ($1, $2, $3, 'customer', 'active')",
                &[&project_id, &org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities, updated_at
                 ) VALUES (
                     $1, $2, 'self-hosted', 'ready', 'http://desktop.invalid',
                     $3, 600, now(), $4, now()
                 )",
                &[
                    &runtime_id,
                    &project_id,
                    &format!("personal-browser-dispatch-{runtime_id}"),
                    &PgJson(capabilities),
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64,
                     metadata, is_default
                 ) VALUES (
                     $1, $2, 'openai_api_key', 'Personal Browser dispatch regression',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, true
                 )",
                &[&credential_id, &user_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "dispatch-personal-browser-pinning",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: "instafy-cloud".to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    let state = build_test_state(pool.clone(), config);
    assert!(
        crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(
            &state.provider_registry.default_provider_id()
        )
    );

    let normalized = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Use my signed-in browser to inspect the visible page.".to_string()),
        intent: Some("browser".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "browserTransport": "desktop-personal",
            "agentSelection": {
                "active": ["octo"],
                "mentions": ["octo"]
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: Some(runtime_id.to_string()),
        runtime_display_name: None,
        prefer_runtime: Some(true),
    })
    .map_err(|error| controller_error("normalize Personal Browser dispatch", error))?;

    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        normalized,
    )
    .await
    .map_err(|error| controller_error("process Personal Browser dispatch", error))?;

    let run_id = response.run_id.expect("Personal Browser run id");
    let job_id = response.job_id.expect("Personal Browser job id");
    let connection = pool.get().await?;
    let job = connection
        .query_one(
            "SELECT target_runtime_id, payload->'metadata' AS metadata
             FROM agent_jobs
             WHERE id = $1 AND project_id = $2",
            &[&job_id, &project_id],
        )
        .await?;
    assert_eq!(
        job.get::<_, Option<Uuid>>("target_runtime_id"),
        Some(runtime_id),
        "Personal Browser work must stay pinned to its owning desktop runtime"
    );
    let job_metadata: serde_json::Value = job.get("metadata");
    assert_eq!(job_metadata["browserTransport"], "desktop-personal");

    let run_metadata: PgJson<serde_json::Value> = connection
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get("metadata");
    assert_ne!(
        run_metadata.0["runtimeAlert"]["reason"],
        json!("runtime_unavailable")
    );
    let runtime_alert_message_count: i64 = connection
        .query_one(
            "SELECT count(*)::bigint
             FROM conversation_messages
             WHERE conversation_id = $1
               AND metadata->>'kind' = 'runtime_alert'
               AND metadata#>>'{details,reason}' = 'runtime_unavailable'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(runtime_alert_message_count, 0);

    let provider: String = connection
        .query_one(
            "SELECT provider FROM runtimes WHERE id = $1",
            &[&runtime_id],
        )
        .await?
        .get("provider");
    assert_eq!(provider, "self-hosted");
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &user_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_scopes_explicit_multi_agent_job_prompts() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping multi-agent dispatch scope test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let prompt = "@ben what is 4+4? @octo write a one-line mountain poem.";

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-multi-agent-scope",
        ),
    );
    let request_body = DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt.to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"]
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    };
    let normalized = dispatch::normalize_dispatch_request(request_body)
        .map_err(|error| controller_error("normalize dispatch request", error))?;
    let context = RequestContext {
        user_id: None,
        is_service_role: true,
        scoped_claims: None,
    };

    let response = dispatch::process_dispatch_prompt(&state, &context, normalized)
        .await
        .map_err(|error| controller_error("process dispatch prompt", error))?;

    assert_eq!(response.conversation_id, Some(conversation_id));
    assert_eq!(response.run_ids.as_ref().map(Vec::len), Some(2));
    assert_eq!(response.job_ids.as_ref().map(Vec::len), Some(2));

    let mut prompts_by_handle = {
        let connection = pool.get().await?;
        let rows = connection
            .query(
                "SELECT payload->'metadata'->'agent'->>'handle' AS handle,
                        payload->>'prompt_text' AS prompt_text
                 FROM agent_jobs
                 WHERE project_id = $1
                   AND prompt_id = $2
                 ORDER BY payload->'metadata'->'agent'->>'handle'",
                &[&project_id, &response.prompt_id],
            )
            .await?;

        let mut values = HashMap::new();
        for row in rows {
            let handle: String = row.get("handle");
            let prompt_text: String = row.get("prompt_text");
            values.insert(handle, prompt_text);
        }
        values
    };

    assert_eq!(prompts_by_handle.len(), 2);
    assert_eq!(
        prompts_by_handle.remove("ben").as_deref(),
        Some("@ben what is 4+4?")
    );
    assert_eq!(
        prompts_by_handle.remove("octo").as_deref(),
        Some("@octo write a one-line mountain poem.")
    );

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "SELECT content
                 FROM conversation_messages
                 WHERE project_id = $1
                   AND prompt_id = $2
                   AND role = 'user'",
                &[&project_id, &response.prompt_id],
            )
            .await?;
        let persisted_content: String = row.get("content");
        assert_eq!(persisted_content, prompt);
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_scopes_auto_fanout_job_prompts_from_metadata() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping auto fanout dispatch scope test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let prompt = "Find security issues in this large project. Do not edit files.";

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-auto-fanout-scope",
        ),
    );
    let request_body = DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt.to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "agentSelection": {
                "active": ["sec-front", "sec-api"],
                "mentions": [],
                "promptSegments": {
                    "sec-front": "Read-only frontend security audit.",
                    "sec-api": "Read-only controller API security audit."
                }
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    };
    let normalized = dispatch::normalize_dispatch_request(request_body)
        .map_err(|error| controller_error("normalize dispatch request", error))?;
    let context = RequestContext {
        user_id: None,
        is_service_role: true,
        scoped_claims: None,
    };

    let response = dispatch::process_dispatch_prompt(&state, &context, normalized)
        .await
        .map_err(|error| controller_error("process dispatch prompt", error))?;

    assert_eq!(response.run_ids.as_ref().map(Vec::len), Some(2));
    assert_eq!(response.job_ids.as_ref().map(Vec::len), Some(2));

    let mut prompts_by_handle = {
        let connection = pool.get().await?;
        let rows = connection
            .query(
                "SELECT payload->'metadata'->'agent'->>'handle' AS handle,
                        payload->>'prompt_text' AS prompt_text,
                        payload->'metadata'->'writeScope'->>'mode' AS write_scope_mode
                 FROM agent_jobs
                 WHERE project_id = $1
                   AND prompt_id = $2
                 ORDER BY payload->'metadata'->'agent'->>'handle'",
                &[&project_id, &response.prompt_id],
            )
            .await?;

        let mut values = HashMap::new();
        for row in rows {
            let handle: String = row.get("handle");
            let prompt_text: String = row.get("prompt_text");
            let write_scope_mode: String = row.get("write_scope_mode");
            assert_eq!(write_scope_mode, "read_only");
            values.insert(handle, prompt_text);
        }
        values
    };

    assert_eq!(prompts_by_handle.len(), 2);
    assert_eq!(
        prompts_by_handle.remove("sec-api").as_deref(),
        Some("Read-only controller API security audit.")
    );
    assert_eq!(
        prompts_by_handle.remove("sec-front").as_deref(),
        Some("Read-only frontend security audit.")
    );

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_attaches_disjoint_write_scopes_to_multi_agent_jobs() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping multi-agent write-scope test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let prompt = "@ben edit src/auth/Login.tsx. @octo update docs/Auth.md.";

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-multi-agent-write-scopes",
        ),
    );
    let request_body = DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt.to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "writeIntent": true,
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"],
                "writeScopes": {
                    "ben": ["src/auth/Login.tsx"],
                    "octo": ["docs/Auth.md"]
                }
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    };
    let normalized = dispatch::normalize_dispatch_request(request_body)
        .map_err(|error| controller_error("normalize dispatch request", error))?;
    let context = RequestContext {
        user_id: None,
        is_service_role: true,
        scoped_claims: None,
    };

    let response = dispatch::process_dispatch_prompt(&state, &context, normalized)
        .await
        .map_err(|error| controller_error("process dispatch prompt", error))?;

    let connection = pool.get().await?;
    let rows = connection
        .query(
            "SELECT payload->'metadata'->'agent'->>'handle' AS handle,
                    payload->'metadata'->'writeScope' AS write_scope
             FROM agent_jobs
             WHERE project_id = $1
               AND prompt_id = $2
             ORDER BY payload->'metadata'->'agent'->>'handle'",
            &[&project_id, &response.prompt_id],
        )
        .await?;

    let mut scopes = HashMap::new();
    for row in rows {
        let handle: String = row.get("handle");
        let scope: serde_json::Value = row.get("write_scope");
        scopes.insert(handle, scope);
    }

    assert_eq!(scopes["ben"]["mode"], json!("owned"));
    assert_eq!(scopes["ben"]["ownedPaths"], json!(["src/auth/Login.tsx"]));
    assert_eq!(scopes["octo"]["mode"], json!("owned"));
    assert_eq!(scopes["octo"]["ownedPaths"], json!(["docs/Auth.md"]));

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_marks_overlapping_write_scopes_coordination_required() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping multi-agent write-scope conflict test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let prompt = "@ben edit src/App.tsx. @octo also update src/App.tsx.";

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-multi-agent-write-conflict",
        ),
    );
    let request_body = DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt.to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "writeIntent": true,
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"],
                "writeScopes": {
                    "ben": ["src/App.tsx"],
                    "octo": ["src/App.tsx"]
                }
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    };
    let normalized = dispatch::normalize_dispatch_request(request_body)
        .map_err(|error| controller_error("normalize dispatch request", error))?;
    let context = RequestContext {
        user_id: None,
        is_service_role: true,
        scoped_claims: None,
    };

    let response = dispatch::process_dispatch_prompt(&state, &context, normalized)
        .await
        .map_err(|error| controller_error("process dispatch prompt", error))?;

    let connection = pool.get().await?;
    let rows = connection
        .query(
            "SELECT payload->'metadata'->'writeScope' AS write_scope
             FROM agent_jobs
             WHERE project_id = $1
               AND prompt_id = $2",
            &[&project_id, &response.prompt_id],
        )
        .await?;

    assert_eq!(rows.len(), 2);
    for row in rows {
        let scope: serde_json::Value = row.get("write_scope");
        assert_eq!(scope["mode"], json!("coordination_required"));
        assert_eq!(
            scope["conflict"]["reason"],
            json!("overlapping_write_scope")
        );
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_prompt_preserves_write_scope_metadata_for_agent_thread() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping linked thread write-scope test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let parent_conversation_id = Uuid::new_v4();
    let thread_conversation_id = Uuid::new_v4();

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO conversations (id, project_id, metadata, visibility)
                 VALUES ($1, $2, '{}'::jsonb, 'public')",
                &[&parent_conversation_id, &project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "dispatch-thread-write-scope",
        ),
    );
    let request_body = DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("@octo update src/App.tsx in a separate thread.".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "writeIntent": true,
            "agentSelection": {
                "active": ["octo"],
                "mentions": ["octo"]
            },
            "agentCollaboration": {
                "mode": "thread"
            },
            "writeScope": {
                "ownedPaths": ["src/App.tsx"],
                "rationale": "frontend selected linked thread ownership"
            }
        })),
        conversation_metadata: None,
        parent_conversation_id: Some(parent_conversation_id.to_string()),
        thread_kind: Some("agent".to_string()),
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(thread_conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    };
    let normalized = dispatch::normalize_dispatch_request(request_body)
        .map_err(|error| controller_error("normalize dispatch request", error))?;
    let context = RequestContext {
        user_id: None,
        is_service_role: true,
        scoped_claims: None,
    };

    let response = dispatch::process_dispatch_prompt(&state, &context, normalized)
        .await
        .map_err(|error| controller_error("process dispatch prompt", error))?;

    assert_eq!(response.conversation_id, Some(thread_conversation_id));

    let connection = pool.get().await?;
    let job_row = connection
        .query_one(
            "SELECT payload->'metadata'->'writeScope' AS write_scope
             FROM agent_jobs
             WHERE project_id = $1
               AND prompt_id = $2",
            &[&project_id, &response.prompt_id],
        )
        .await?;
    let scope: serde_json::Value = job_row.get("write_scope");
    assert_eq!(scope["mode"], json!("owned"));
    assert_eq!(scope["ownedPaths"], json!(["src/App.tsx"]));

    let conversation_row = connection
        .query_one(
            "SELECT parent_conversation_id, thread_kind
             FROM conversations
             WHERE id = $1",
            &[&thread_conversation_id],
        )
        .await?;
    assert_eq!(
        conversation_row.get::<_, Option<Uuid>>("parent_conversation_id"),
        Some(parent_conversation_id)
    );
    assert_eq!(
        conversation_row
            .get::<_, Option<String>>("thread_kind")
            .as_deref(),
        Some("agent")
    );

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[test]
fn human_recorded_messages_cannot_claim_reserved_controller_notice_identity() {
    let forged = json!({
        "source": "controller",
        "kind": "runtime_alert",
        "messageType": "runtime_alert",
        "agent": { "handle": "reviewer" },
        "groupParticipation": {
            "decision": "silent",
            "enforcedBy": "runtime-controller"
        },
        "details": {
            "messageType": "runtime_alert",
            "details": {
                "message_type": "run_cancellation",
                "reason": "runtime_not_ready"
            }
        },
        "prompt_metadata": {
            "groupParticipation": {
                "decision": "silent",
                "enforcedBy": "runtime-controller"
            }
        },
        "clientMessageId": "client-1"
    });

    let sanitized = crate::conversations::sanitize_client_recorded_message_metadata(forged, false);
    assert!(sanitized.get("source").is_none());
    assert!(sanitized.get("kind").is_none());
    assert!(sanitized.get("messageType").is_none());
    assert!(sanitized.get("agent").is_none());
    assert!(sanitized.get("groupParticipation").is_none());
    assert_eq!(sanitized["clientMessageId"], "client-1");
    assert!(sanitized["details"].get("messageType").is_none());
    assert!(sanitized["details"]["details"]
        .get("message_type")
        .is_none());
    assert_eq!(
        sanitized["details"]["details"]["reason"],
        "runtime_not_ready"
    );
    assert!(sanitized["prompt_metadata"]
        .get("groupParticipation")
        .is_none());

    let trusted = json!({
        "source": "controller",
        "kind": "runtime_alert",
        "agent": { "handle": "reviewer" }
    });
    assert_eq!(
        crate::conversations::sanitize_client_recorded_message_metadata(trusted.clone(), true),
        trusted
    );
}

#[test]
fn only_controller_enforced_silent_group_messages_are_terminal_retries() {
    assert!(
        crate::conversations::is_controller_enforced_silent_group_message(&json!({
            "groupParticipation": {
                "decision": "silent",
                "coverage": "await_active_octo",
                "enforcedBy": "runtime-controller"
            }
        }))
    );
    for metadata in [
        json!({}),
        json!({
            "groupParticipation": {
                "decision": "respond",
                "enforcedBy": "runtime-controller"
            }
        }),
        json!({
            "groupParticipation": {
                "decision": "silent",
                "enforcedBy": "client"
            }
        }),
        json!({
            "prompt_metadata": {
                "groupParticipation": {
                    "decision": "silent",
                    "enforcedBy": "runtime-controller"
                }
            }
        }),
    ] {
        assert!(
            !crate::conversations::is_controller_enforced_silent_group_message(&metadata),
            "untrusted or non-terminal metadata must not suppress dispatch: {metadata}"
        );
    }
}

#[test]
fn message_idempotency_is_scoped_to_exact_author_role_and_content() {
    let author_id = Uuid::new_v4();
    let message = crate::conversations::ConversationMessageRow {
        id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        session_id: None,
        created_by: Some(author_id),
        prompt_id: None,
        run_id: None,
        role: "user".to_string(),
        content: "1+1=3".to_string(),
        metadata: json!({ "clientMessageId": "shared-visible-id" }),
        created_at: Utc::now(),
    };
    crate::conversations::ensure_conversation_message_idempotency_match(
        &message,
        Some(author_id),
        "user",
        "1+1=3",
    )
    .expect("the exact retry must match");

    for (created_by, role, content) in [
        (Some(Uuid::new_v4()), "user", "1+1=3"),
        (Some(author_id), "assistant", "1+1=3"),
        (Some(author_id), "user", "1+1=2"),
        (None, "user", "1+1=3"),
    ] {
        let error = crate::conversations::ensure_conversation_message_idempotency_match(
            &message, created_by, role, content,
        )
        .expect_err("a client id collision must not be reused");
        assert_eq!(error.0, StatusCode::CONFLICT);
    }
}

#[tokio::test]
async fn record_conversation_message_route_is_idempotent_for_client_message_id(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping conversation message idempotency test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let outsider_user_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &outsider_user_id).await?;

    {
        let connection = pool.get().await?;
        connection
            .batch_execute(
                "alter table if exists conversations
                     add column if not exists visibility text not null default 'public',
                     add column if not exists parent_conversation_id uuid,
                     add column if not exists root_conversation_id uuid,
                     add column if not exists thread_kind text,
                     add column if not exists last_message_id uuid,
                     add column if not exists last_message_at timestamptz,
                     add column if not exists last_message_preview text;
                 create table if not exists conversation_participants (
                     conversation_id uuid not null,
                     user_id uuid not null,
                     role text not null default 'member',
                     added_by uuid,
                     last_seen_message_id uuid,
                     last_seen_at timestamptz,
                     created_at timestamptz not null default now(),
                     primary key (conversation_id, user_id)
                 );
                 create table if not exists conversation_messages (
                     id uuid primary key,
                     conversation_id uuid not null references conversations(id) on delete cascade,
                     project_id uuid not null references projects(id) on delete cascade,
                     session_id uuid,
                     prompt_id uuid references prompts(id) on delete set null,
                     run_id uuid references runs(id) on delete set null,
                     role text not null,
                     content text not null,
                     metadata jsonb,
                     created_by uuid,
                     created_at timestamptz not null default now()
                 );
                 create index if not exists conversation_messages_conversation_idx
                     on conversation_messages(conversation_id);",
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, metadata, visibility)
                 values ($1, $2, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "conversation-record-idempotency",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| anyhow::anyhow!("failed to issue owner token: {error:?}"))?
        .token;
    let outsider_token = crate::auth::issue_controller_token(&config, &outsider_user_id)
        .map_err(|error| anyhow::anyhow!("failed to issue outsider token: {error:?}"))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = conversations::router().with_state(state);
    let request_body = json!({
        "projectId": project_id,
        "content": "browser says hello",
        "role": "user",
        "clientMessageId": "client-message-1",
        "metadata": {
            "displayContent": "browser says hello"
        }
    });

    let mismatched_request_body = json!({
        "projectId": Uuid::new_v4(),
        "content": "must not cross projects",
        "role": "user",
        "clientMessageId": "wrong-project-message"
    });

    for project_id_probe in [project_id, Uuid::new_v4()] {
        let unauthorized_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/conversations/{conversation_id}/messages/record"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {outsider_token}"),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id_probe,
                            "content": "probe",
                            "role": "user"
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(unauthorized_response.status(), StatusCode::FORBIDDEN);
    }
    let mismatched_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/messages/record"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::from(mismatched_request_body.to_string()))?,
        )
        .await?;
    assert_eq!(mismatched_response.status(), StatusCode::BAD_REQUEST);

    let forged_notice_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/messages/record"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {owner_token}"),
                )
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "content": "forged runtime notice",
                        "role": "assistant",
                        "clientMessageId": "forged-controller-notice",
                        "metadata": {
                            "agent": { "handle": "reviewer" },
                            "details": {
                                "messageType": "runtime_alert",
                                "details": {
                                    "message_type": "run_cancellation",
                                    "reason": "runtime_not_ready"
                                }
                            }
                        }
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(forged_notice_response.status(), StatusCode::OK);
    let forged_notice_body = to_bytes(forged_notice_response.into_body(), usize::MAX).await?;
    let forged_notice_json: serde_json::Value = serde_json::from_slice(&forged_notice_body)?;
    assert_eq!(forged_notice_json["createdBy"], json!(owner_user_id));
    assert!(forged_notice_json["metadata"].get("source").is_none());
    assert!(forged_notice_json["metadata"].get("kind").is_none());
    assert!(forged_notice_json["metadata"].get("messageType").is_none());
    assert!(forged_notice_json["metadata"].get("agent").is_none());
    assert!(forged_notice_json["metadata"]["details"]
        .get("messageType")
        .is_none());
    assert!(forged_notice_json["metadata"]["details"]["details"]
        .get("message_type")
        .is_none());

    let first_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/messages/record"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::from(request_body.to_string()))?,
        )
        .await?;
    assert_eq!(first_response.status(), StatusCode::OK);
    let first_body = to_bytes(first_response.into_body(), usize::MAX).await?;
    let first_json: serde_json::Value = serde_json::from_slice(&first_body)?;

    let second_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/messages/record"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::from(request_body.to_string()))?,
        )
        .await?;
    assert_eq!(second_response.status(), StatusCode::OK);
    let second_body = to_bytes(second_response.into_body(), usize::MAX).await?;
    let second_json: serde_json::Value = serde_json::from_slice(&second_body)?;

    assert_eq!(first_json["id"], second_json["id"]);
    assert_eq!(
        first_json["metadata"]["clientMessageId"].as_str(),
        Some("client-message-1")
    );
    assert_eq!(
        second_json["metadata"]["clientMessageId"].as_str(),
        Some("client-message-1")
    );

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "select count(*) from conversation_messages where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        let count: i64 = row.get(0);
        assert_eq!(count, 2);
    }

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &outsider_user_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn conversation_message_routes_preserve_inline_reference_content() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!(
            "skipping conversation inline reference persistence test: TEST_DATABASE_URL not set"
        );
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let referenced_conversation_id = Uuid::new_v4();
    let referenced_message_id = Uuid::new_v4();
    let content = format!(
        "Tracked in [[thread:{referenced_conversation_id}|@octo auth]]. See [[message:{referenced_conversation_id}/{referenced_message_id}|latest trace]].\nCommand output: \u{001b}[31mfailed\u{001b}[0m\tbell:\u{0007}"
    );

    {
        let connection = pool.get().await?;
        connection
            .batch_execute(
                "alter table if exists conversations
                     add column if not exists visibility text not null default 'public',
                     add column if not exists parent_conversation_id uuid,
                     add column if not exists root_conversation_id uuid,
                     add column if not exists thread_kind text,
                     add column if not exists last_message_id uuid,
                     add column if not exists last_message_at timestamptz,
                     add column if not exists last_message_preview text;
                 create table if not exists conversation_participants (
                     conversation_id uuid not null,
                     user_id uuid not null,
                     role text not null default 'member',
                     added_by uuid,
                     last_seen_message_id uuid,
                     last_seen_at timestamptz,
                     created_at timestamptz not null default now(),
                     primary key (conversation_id, user_id)
                 );
                 create table if not exists conversation_messages (
                     id uuid primary key,
                     conversation_id uuid not null references conversations(id) on delete cascade,
                     project_id uuid not null references projects(id) on delete cascade,
                     session_id uuid,
                     prompt_id uuid references prompts(id) on delete set null,
                     run_id uuid references runs(id) on delete set null,
                     role text not null,
                     content text not null,
                     metadata jsonb,
                     created_by uuid,
                     created_at timestamptz not null default now()
                 );
                 create index if not exists conversation_messages_conversation_idx
                     on conversation_messages(conversation_id);",
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, metadata, visibility)
                 values ($1, $2, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "conversation-inline-ref-persistence",
        ),
    );
    let app = conversations::router().with_state(state);
    let request_body = json!({
        "content": content,
        "role": "assistant",
        "metadata": {
            "source": "agent"
        }
    });

    let record_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/messages/record"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::from(request_body.to_string()))?,
        )
        .await?;
    assert_eq!(record_response.status(), StatusCode::OK);
    let record_body = to_bytes(record_response.into_body(), usize::MAX).await?;
    let record_json: serde_json::Value = serde_json::from_slice(&record_body)?;
    assert_eq!(record_json["content"], json!(content));

    let list_response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/conversations/{conversation_id}/messages"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_static("Bearer service-role-token"),
                )
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = to_bytes(list_response.into_body(), usize::MAX).await?;
    let list_json: serde_json::Value = serde_json::from_slice(&list_body)?;
    assert_eq!(list_json["messages"][0]["content"], json!(content));
    assert_eq!(
        list_json["messages"][0]["metadata"]["source"],
        json!("agent")
    );

    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "select content from conversation_messages where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        let persisted_content: String = row.get("content");
        assert_eq!(persisted_content, content);
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[test]
fn conversation_messages_page_serializes_control_character_content_as_valid_json() {
    let conversation_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let content = "Command output:\n\u{001b}[31mfailed\u{001b}[0m\r\nbell:\u{0007}\ttabbed";
    let page = crate::conversations::ConversationMessagesPage {
        messages: vec![crate::conversations::ConversationMessagePayload {
            id: Uuid::new_v4(),
            conversation_id,
            project_id,
            session_id: None,
            created_by: None,
            prompt_id: None,
            run_id: None,
            role: "assistant".to_string(),
            content: content.to_string(),
            metadata: json!({
                "source": "agent",
                "trace": "\u{001b}[32mmetadata\u{001b}[0m",
            }),
            created_at: "2026-06-06T00:00:00Z".to_string(),
        }],
        next_cursor: None,
        has_more: false,
    };

    let bytes = serde_json::to_vec(&page).expect("serialize conversation messages page");
    let encoded = String::from_utf8(bytes.clone()).expect("json utf8");
    assert!(!encoded.contains('\u{001b}'));
    assert!(!encoded.contains('\u{0007}'));

    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).expect("message response remains valid JSON");
    assert_eq!(parsed["messages"][0]["content"], json!(content));
    assert_eq!(
        parsed["messages"][0]["metadata"]["trace"],
        json!("\u{001b}[32mmetadata\u{001b}[0m")
    );
}

async fn create_runtime_tables(client: &mut tokio_postgres::Client) -> anyhow::Result<()> {
    client
        .batch_execute(
            "CREATE TEMP TABLE runtimes (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                provider text NOT NULL,
                status text NOT NULL,
                endpoint_url text,
                task_ref text,
                capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
                idle_ttl_seconds integer NOT NULL,
                last_seen_at timestamptz,
                display_name text,
                active_lease_id uuid,
                drain_expires_at timestamptz,
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TEMP TABLE agent_jobs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                run_id uuid,
                prompt_id uuid,
                session_id uuid,
                conversation_id uuid,
                intent text,
                status text NOT NULL,
                outcome text,
                summary text,
                error_message text,
                payload jsonb NOT NULL,
                priority integer NOT NULL DEFAULT 100,
                lease_attempts integer NOT NULL DEFAULT 0,
                leased_at timestamptz,
                lease_expires_at timestamptz,
                target_runtime_id uuid,
                leased_by_runtime_id uuid,
                heartbeat_at timestamptz,
                completed_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                project_id uuid,
                status text NOT NULL DEFAULT 'queued',
                progress double precision NOT NULL DEFAULT 0,
                progress_stage text,
                last_message text,
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TEMP TABLE runtime_events (
                id bigserial PRIMARY KEY,
                runtime_id uuid NOT NULL,
                project_id uuid NOT NULL,
                kind text NOT NULL,
                data jsonb NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TEMP TABLE origin_instances (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                runtime_id uuid,
                lease_id uuid,
                origin_id uuid,
                required boolean NOT NULL DEFAULT false,
                mode text,
                status text NOT NULL,
                endpoint text,
                protocols text[] NOT NULL DEFAULT array[]::text[],
                metadata jsonb,
                token_hash text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;

    Ok(())
}

#[tokio::test]
async fn scoped_runtime_events_store_only_safe_data_and_validate_project_binding(
) -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping scoped runtime event test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE conversations (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL
            );
            CREATE TEMP TABLE runtime_events (
                runtime_id uuid NOT NULL,
                project_id uuid NOT NULL,
                conversation_id uuid,
                kind text NOT NULL,
                data jsonb NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );",
        )
        .await?;

    let project_id = Uuid::new_v4();
    let other_project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO conversations (id, project_id) VALUES ($1, $2)",
            &[&conversation_id, &project_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    runtime::record_runtime_event_with_conversation(
        &transaction,
        &runtime_id,
        &project_id,
        Some(&conversation_id),
        "agent.complete",
        json!({
            "job_id": Uuid::new_v4(),
            "run_id": Uuid::new_v4(),
            "outcome": "succeeded",
            "summary": "private answer",
            "proxy_metadata": { "secret": "private state" }
        }),
    )
    .await
    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;

    let row = transaction
        .query_one(
            "SELECT conversation_id, data FROM runtime_events WHERE runtime_id = $1",
            &[&runtime_id],
        )
        .await?;
    assert_eq!(
        row.get::<_, Option<Uuid>>("conversation_id"),
        Some(conversation_id)
    );
    let data = row.get::<_, PgJson<serde_json::Value>>("data").0;
    assert_eq!(data["outcome"], "succeeded");
    assert!(data.get("summary").is_none());
    assert!(data.get("proxy_metadata").is_none());

    let mismatch = runtime::record_runtime_event_with_conversation(
        &transaction,
        &Uuid::new_v4(),
        &other_project_id,
        Some(&conversation_id),
        "agent.complete",
        json!({ "outcome": "succeeded" }),
    )
    .await;
    assert!(mismatch.is_err());

    transaction.rollback().await?;
    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn runtime_idle_sweep_removes_stale_terminal_records() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping runtime terminal cleanup test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let stale_offline_runtime = Uuid::new_v4();
    let stale_stopped_runtime = Uuid::new_v4();
    let recent_offline_runtime = Uuid::new_v4();
    let stale_offline_with_active_lease = Uuid::new_v4();
    let active_lease_id = Uuid::new_v4();
    let personal_browser_run_id = Uuid::new_v4();
    let personal_browser_job_id = Uuid::new_v4();
    let provider_id = format!("terminal-cleanup-test-{}", Uuid::new_v4().simple());
    let provider_release_attempts = Arc::new(AtomicUsize::new(0));
    let provider_app = axum::Router::new().route(
        "/runtime/release",
        axum::routing::post({
            let provider_release_attempts = provider_release_attempts.clone();
            move || {
                let provider_release_attempts = provider_release_attempts.clone();
                async move {
                    provider_release_attempts.fetch_add(1, Ordering::SeqCst);
                    StatusCode::NO_CONTENT
                }
            }
        }),
    );
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider_listener.local_addr()?;
    let provider_handle = tokio::spawn(async move {
        axum::serve(provider_listener, provider_app)
            .await
            .expect("serve terminal cleanup provider test");
    });

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, endpoint_url, task_ref, idle_ttl_seconds, last_seen_at, updated_at)
                 VALUES
                   ($1, $2, 'self-hosted', 'offline', 'http://stale-offline', 'task-offline', 600, now() - interval '2 hours', now() - interval '30 minutes'),
                   ($3, $2, 'self-hosted', 'stopped', 'http://stale-stopped', 'task-stopped', 600, now() - interval '2 hours', now() - interval '35 minutes'),
                   ($4, $2, 'self-hosted', 'offline', 'http://recent-offline', 'task-recent', 600, now() - interval '2 minutes', now() - interval '2 minutes'),
                   ($5, $2, $6, 'offline', 'http://leased-offline', 'task-lease', 600, now() - interval '90 minutes', now() - interval '40 minutes')",
                &[
                    &stale_offline_runtime,
                    &project_id,
                    &stale_stopped_runtime,
                    &recent_offline_runtime,
                    &stale_offline_with_active_lease,
                    &provider_id,
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                 VALUES ($1, $2, $3, 'active', now() - interval '1 hour', now() - interval '1 hour')",
                &[&active_lease_id, &project_id, &stale_offline_with_active_lease],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runs (
                     id, project_id, run_type, status, progress, progress_stage
                 ) VALUES ($1, $2, 'prompt', 'queued', 0, 'agent:queued')",
                &[&personal_browser_run_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO agent_jobs (
                     id, project_id, run_id, status, payload, priority, target_runtime_id
                 ) VALUES (
                     $1, $2, $3, 'queued', $4, 10, $5
                 )",
                &[
                    &personal_browser_job_id,
                    &project_id,
                    &personal_browser_run_id,
                    &PgJson(json!({
                        "prompt_text": "use the Personal Browser",
                        "metadata": { "browserTransport": "desktop-personal" }
                    })),
                    &stale_offline_runtime,
                ],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&stale_offline_with_active_lease, &active_lease_id],
            )
            .await?;
        connection
            .batch_execute("ALTER TABLE runtimes DISABLE TRIGGER set_runtimes_updated_at;")
            .await?;
        connection
            .execute(
                "UPDATE runtimes
                 SET updated_at = now() - interval '40 minutes'
                 WHERE id = $1",
                &[&stale_offline_with_active_lease],
            )
            .await?;
        connection
            .batch_execute("ALTER TABLE runtimes ENABLE TRIGGER set_runtimes_updated_at;")
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "runtime-sweep-terminal-cleanup",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: provider_id,
        display_name: "Terminal cleanup provider".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    }];
    let state = build_test_state(pool.clone(), config);

    runtime::sweep_idle_activity(&state).await?;
    assert_eq!(provider_release_attempts.load(Ordering::SeqCst), 1);

    {
        let connection = pool.get().await?;
        let stale_offline_row = connection
            .query_one(
                "SELECT status, endpoint_url, task_ref FROM runtimes WHERE id = $1",
                &[&stale_offline_runtime],
            )
            .await?;
        assert_eq!(stale_offline_row.get::<_, String>("status"), "removed");
        assert!(stale_offline_row
            .get::<_, Option<String>>("endpoint_url")
            .is_none());
        assert!(stale_offline_row
            .get::<_, Option<String>>("task_ref")
            .is_none());

        let stale_stopped_row = connection
            .query_one(
                "SELECT status, endpoint_url, task_ref FROM runtimes WHERE id = $1",
                &[&stale_stopped_runtime],
            )
            .await?;
        assert_eq!(stale_stopped_row.get::<_, String>("status"), "removed");
        assert!(stale_stopped_row
            .get::<_, Option<String>>("endpoint_url")
            .is_none());
        assert!(stale_stopped_row
            .get::<_, Option<String>>("task_ref")
            .is_none());

        let recent_row = connection
            .query_one(
                "SELECT status FROM runtimes WHERE id = $1",
                &[&recent_offline_runtime],
            )
            .await?;
        assert_eq!(recent_row.get::<_, String>("status"), "offline");

        let active_lease_row = connection
            .query_one(
                "SELECT status FROM runtimes WHERE id = $1",
                &[&stale_offline_with_active_lease],
            )
            .await?;
        assert_eq!(active_lease_row.get::<_, String>("status"), "removed");

        let lease_row = connection
            .query_one(
                "SELECT status, released_at FROM runtime_leases WHERE id = $1",
                &[&active_lease_id],
            )
            .await?;
        assert_eq!(lease_row.get::<_, String>("status"), "released");
        assert!(lease_row
            .get::<_, Option<chrono::DateTime<Utc>>>("released_at")
            .is_some());

        let personal_job_row = connection
            .query_one(
                "SELECT status, error_message, target_runtime_id
                 FROM agent_jobs WHERE id = $1",
                &[&personal_browser_job_id],
            )
            .await?;
        assert_eq!(personal_job_row.get::<_, String>("status"), "failed");
        assert_eq!(
            personal_job_row
                .get::<_, Option<String>>("error_message")
                .as_deref(),
            Some(runtime::PERSONAL_BROWSER_DISCONNECTED_ERROR)
        );
        assert_eq!(
            personal_job_row.get::<_, Option<Uuid>>("target_runtime_id"),
            Some(stale_offline_runtime)
        );

        let personal_run_row = connection
            .query_one(
                "SELECT status, last_message FROM runs WHERE id = $1",
                &[&personal_browser_run_id],
            )
            .await?;
        assert_eq!(personal_run_row.get::<_, String>("status"), "failed");
        assert_eq!(
            personal_run_row
                .get::<_, Option<String>>("last_message")
                .as_deref(),
            Some(runtime::PERSONAL_BROWSER_DISCONNECTED_ERROR)
        );

        let disconnect_events: i64 = connection
            .query_one(
                "SELECT count(*) FROM runtime_events
                 WHERE runtime_id = $1 AND kind = 'personal_browser_disconnected'",
                &[&stale_offline_runtime],
            )
            .await?
            .get(0);
        assert_eq!(disconnect_events, 1);
    }

    cleanup_origin_project(&pool, &project_id).await?;
    provider_handle.abort();
    Ok(())
}

#[tokio::test]
async fn runtime_idle_sweep_stops_stuck_requested_runtimes() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping stuck requested runtime sweep test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let stale_requested_runtime = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let provider_id = format!("instafy-cloud-test-{}", Uuid::new_v4().simple());
    let provider_app = axum::Router::new().route(
        "/runtime/release",
        axum::routing::post(|| async { StatusCode::NO_CONTENT }),
    );
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider_listener.local_addr()?;
    let provider_handle = tokio::spawn(async move {
        axum::serve(provider_listener, provider_app)
            .await
            .expect("serve stuck-requested provider test");
    });

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at, updated_at)
                 VALUES ($1, $2, $3, 'requested', 3600, null, now() - interval '2 hours')",
                &[&stale_requested_runtime, &project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (id, project_id, runtime_id, status, requested_at)
                 VALUES ($1, $2, $3, 'launching', now() - interval '2 hours')",
                &[&lease_id, &project_id, &stale_requested_runtime],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&stale_requested_runtime, &lease_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "runtime-sweep-requested-timeout",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: provider_id.clone(),
        display_name: "Stuck requested provider".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    }];
    let state = build_test_state(pool.clone(), config);

    runtime::sweep_idle_activity(&state).await?;

    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status, active_lease_id FROM runtimes WHERE id = $1",
                &[&stale_requested_runtime],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "stopped");
        assert!(runtime_row
            .get::<_, Option<Uuid>>("active_lease_id")
            .is_none());

        let lease_row = connection
            .query_one(
                "SELECT status, released_at FROM runtime_leases WHERE id = $1",
                &[&lease_id],
            )
            .await?;
        assert_eq!(lease_row.get::<_, String>("status"), "released");
        assert!(lease_row
            .get::<_, Option<chrono::DateTime<Utc>>>("released_at")
            .is_some());

        let provider_acknowledgements: i64 = connection
            .query_one(
                "SELECT count(*) FROM runtime_events
                 WHERE runtime_id = $1
                   AND kind = 'provider_release_acknowledged'
                   AND data ->> 'runtimeLeaseId' = $2",
                &[&stale_requested_runtime, &lease_id.to_string()],
            )
            .await?
            .get(0);
        assert_eq!(provider_acknowledgements, 1);

        let bug_row = connection
            .query_one(
                "SELECT message, priority, labels, metadata
                 FROM bug_reports
                 WHERE project_id = $1 AND runtime_id = $2
                 ORDER BY created_at DESC
                 LIMIT 1",
                &[&project_id, &stale_requested_runtime],
            )
            .await?;
        assert_eq!(
            bug_row.get::<_, String>("message"),
            format!("Hosted runtime launch timed out for provider {provider_id}")
        );
        assert_eq!(bug_row.get::<_, String>("priority"), "high");
        let labels: serde_json::Value = bug_row.get("labels");
        assert!(labels
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == "launch-timeout")));
        let metadata: serde_json::Value = bug_row.get("metadata");
        assert_eq!(
            metadata.get("source").and_then(serde_json::Value::as_str),
            Some("runtime.launch_timeout")
        );
    }

    cleanup_origin_project(&pool, &project_id).await?;
    provider_handle.abort();
    Ok(())
}

#[tokio::test]
async fn runtime_idle_sweep_retains_ambiguous_launch_until_provider_release_succeeds(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("cleanup-pending runtime sweep test").await?;

    let release_succeeds = Arc::new(AtomicBool::new(false));
    let release_attempts = Arc::new(AtomicUsize::new(0));
    let provider_app = axum::Router::new().route(
        "/runtime/release",
        axum::routing::post({
            let release_succeeds = release_succeeds.clone();
            let release_attempts = release_attempts.clone();
            move || {
                let release_succeeds = release_succeeds.clone();
                let release_attempts = release_attempts.clone();
                async move {
                    release_attempts.fetch_add(1, Ordering::SeqCst);
                    if release_succeeds.load(Ordering::SeqCst) {
                        StatusCode::NO_CONTENT
                    } else {
                        StatusCode::BAD_GATEWAY
                    }
                }
            }
        }),
    );
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider_listener.local_addr()?;
    let provider_handle = tokio::spawn(async move {
        axum::serve(provider_listener, provider_app)
            .await
            .expect("serve cleanup-pending provider test");
    });

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let provider_id = format!("cleanup-pending-test-{}", Uuid::new_v4().simple());
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status)
                 VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes
                    (id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, updated_at)
                 VALUES ($1, $2, $3, 'requested', 3600, null,
                         now() - interval '2 hours')",
                &[&runtime_id, &project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases
                    (id, project_id, runtime_id, status, requested_at)
                 VALUES ($1, $2, $3, 'cleanup_pending',
                         now() - interval '2 hours')",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "runtime-sweep-cleanup-pending",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: provider_id.clone(),
        display_name: "Cleanup pending provider".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    }];
    let state = build_test_state(pool.clone(), config);

    runtime::sweep_idle_activity(&state).await?;
    assert_eq!(release_attempts.load(Ordering::SeqCst), 1);
    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status, active_lease_id FROM runtimes WHERE id = $1",
                &[&runtime_id],
            )
            .await?;
        let lease_row = connection
            .query_one(
                "SELECT status, released_at FROM runtime_leases WHERE id = $1",
                &[&lease_id],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "requested");
        assert_eq!(
            runtime_row.get::<_, Option<Uuid>>("active_lease_id"),
            Some(lease_id)
        );
        assert_eq!(lease_row.get::<_, String>("status"), "cleanup_pending");
        assert!(lease_row
            .get::<_, Option<chrono::DateTime<Utc>>>("released_at")
            .is_none());
    }

    release_succeeds.store(true, Ordering::SeqCst);
    runtime::sweep_idle_activity(&state).await?;
    assert_eq!(release_attempts.load(Ordering::SeqCst), 2);
    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status, active_lease_id FROM runtimes WHERE id = $1",
                &[&runtime_id],
            )
            .await?;
        let lease_row = connection
            .query_one(
                "SELECT status, released_at FROM runtime_leases WHERE id = $1",
                &[&lease_id],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "stopped");
        assert!(runtime_row
            .get::<_, Option<Uuid>>("active_lease_id")
            .is_none());
        assert_eq!(lease_row.get::<_, String>("status"), "released");
        assert!(lease_row
            .get::<_, Option<chrono::DateTime<Utc>>>("released_at")
            .is_some());
    }

    cleanup_origin_project(&pool, &project_id).await?;
    provider_handle.abort();
    Ok(())
}

#[tokio::test]
async fn runtime_idle_sweep_stops_orphan_requested_runtimes() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping orphan requested runtime sweep test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let stale_requested_runtime = Uuid::new_v4();

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at, updated_at)
                 VALUES ($1, $2, 'instafy-cloud', 'requested', 3600, null, now() - interval '2 hours')",
                &[&stale_requested_runtime, &project_id],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "runtime-sweep-orphan-requested-timeout",
        ),
    );

    runtime::sweep_idle_activity(&state).await?;

    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status, active_lease_id FROM runtimes WHERE id = $1",
                &[&stale_requested_runtime],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "stopped");
        assert!(runtime_row
            .get::<_, Option<Uuid>>("active_lease_id")
            .is_none());
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn runtime_idle_sweep_clears_stale_runtime_job_bindings() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping runtime job binding cleanup test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let stale_runtime = Uuid::new_v4();
    let queued_job_id = Uuid::new_v4();
    let leased_job_id = Uuid::new_v4();
    let payload = PgJson(json!({ "prompt_text": "cleanup stale runtime" }));

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at, updated_at)
                 VALUES ($1, $2, 'self-hosted', 'offline', 600, now() - interval '2 hours', now() - interval '25 minutes')",
                &[&stale_runtime, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO agent_jobs (id, project_id, status, payload, priority, target_runtime_id)
                 VALUES ($1, $2, 'queued', $3, 5, $4)",
                &[&queued_job_id, &project_id, &payload, &stale_runtime],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO agent_jobs (id, project_id, status, payload, priority, leased_by_runtime_id, leased_at, lease_expires_at)
                 VALUES ($1, $2, 'leased', $3, 5, $4, now() - interval '5 minutes', now() + interval '5 minutes')",
                &[&leased_job_id, &project_id, &payload, &stale_runtime],
            )
            .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "runtime-sweep-job-cleanup",
        ),
    );

    runtime::sweep_idle_activity(&state).await?;

    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status FROM runtimes WHERE id = $1",
                &[&stale_runtime],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "removed");

        let queued_job_row = connection
            .query_one(
                "SELECT status, target_runtime_id, leased_by_runtime_id FROM agent_jobs WHERE id = $1",
                &[&queued_job_id],
            )
            .await?;
        assert_eq!(queued_job_row.get::<_, String>("status"), "queued");
        assert!(queued_job_row
            .get::<_, Option<Uuid>>("target_runtime_id")
            .is_none());
        assert!(queued_job_row
            .get::<_, Option<Uuid>>("leased_by_runtime_id")
            .is_none());

        let leased_job_row = connection
            .query_one(
                "SELECT status, target_runtime_id, leased_by_runtime_id FROM agent_jobs WHERE id = $1",
                &[&leased_job_id],
            )
            .await?;
        assert_eq!(leased_job_row.get::<_, String>("status"), "queued");
        assert!(leased_job_row
            .get::<_, Option<Uuid>>("target_runtime_id")
            .is_none());
        assert!(leased_job_row
            .get::<_, Option<Uuid>>("leased_by_runtime_id")
            .is_none());
    }

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn runtime_stop_requeues_leased_jobs() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping runtime stop test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    create_runtime_tables(&mut client).await?;

    let runtime_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let payload = PgJson(json!({ "prompt_text": "stop" }));

    client
        .execute(
            "INSERT INTO runtimes (id, project_id, provider, status, endpoint_url, task_ref, idle_ttl_seconds, last_seen_at)
             VALUES ($1, $2, 'self-hosted', 'ready', 'http://example', 'task-123', 600, now() - interval '1 hour')",
            &[&runtime_id, &project_id],
        )
        .await?;

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority, leased_by_runtime_id, leased_at, lease_expires_at)
             VALUES ($1, $2, NULL, 'leased', $3, 10, $4, now() - interval '5 minutes', now() + interval '10 minutes')",
            &[&job_id, &project_id, &payload, &runtime_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("fetch runtime", error))?;
    let outcome = runtime::perform_runtime_stop(
        &transaction,
        &runtime,
        runtime::StopOptions {
            source: "test",
            reason: Some("unit_test".to_string()),
            skip_if_active_jobs: false,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await
    .map_err(|error| controller_error("perform runtime stop", error))?;
    assert!(outcome.status_changed);
    assert_eq!(outcome.requeued_jobs.len(), 1);
    transaction.commit().await?;

    let runtime_row = client
        .query_one(
            "SELECT status, endpoint_url, task_ref FROM runtimes WHERE id = $1",
            &[&runtime_id],
        )
        .await?;
    let status: String = runtime_row.get("status");
    assert_eq!(status, "stopped");
    let endpoint: Option<String> = runtime_row.get("endpoint_url");
    assert!(endpoint.is_none());
    let task_ref: Option<String> = runtime_row.get("task_ref");
    assert!(task_ref.is_none());

    let job_row = client
        .query_one(
            "SELECT status, leased_by_runtime_id FROM agent_jobs WHERE id = $1",
            &[&job_id],
        )
        .await?;
    let job_status: String = job_row.get("status");
    assert_eq!(job_status, "queued");
    let leased_runtime: Option<Uuid> = job_row.get("leased_by_runtime_id");
    assert!(leased_runtime.is_none());

    let events_count: i64 = client
        .query_one(
            "SELECT count(*) FROM runtime_events WHERE runtime_id = $1 AND kind = 'stopped'",
            &[&runtime_id],
        )
        .await?
        .get(0);
    assert_eq!(events_count, 1);

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn strict_runtime_stop_keeps_exact_lease_fenced_until_provider_ack() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("strict runtime stop endpoint test").await?;

    let release_calls = Arc::new(AtomicUsize::new(0));
    let provider_app = axum::Router::new().route(
        "/runtime/release",
        axum::routing::post({
            let release_calls = release_calls.clone();
            move || {
                let release_calls = release_calls.clone();
                async move {
                    if release_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        StatusCode::INTERNAL_SERVER_ERROR
                    } else {
                        StatusCode::NO_CONTENT
                    }
                }
            }
        }),
    );
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider_listener.local_addr()?;
    let provider_handle = tokio::spawn(async move {
        axum::serve(provider_listener, provider_app)
            .await
            .expect("serve strict release test provider");
    });

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let provider_id = "strict_release_test";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, updated_at
                 ) VALUES ($1, $2, $3, 'ready', 'http://runtime', 'provider-task', 600, now(), now())",
                &[&runtime_id, &project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) VALUES ($1, $2, $3, 'active', now(), now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "strict-runtime-stop-endpoint",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: provider_id.to_string(),
        display_name: "Strict release test provider".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    }];
    let agent_token =
        crate::auth::issue_agent_token(&config, &project_id, &runtime_id, Some(&lease_id), None)
            .map_err(|(status, body)| {
                anyhow::anyhow!("issue agent token: {status}: {}", body.0.message)
            })?
            .token;
    let stale_lease_id = Uuid::new_v4();
    let stale_agent_token = crate::auth::issue_agent_token(
        &config,
        &project_id,
        &runtime_id,
        Some(&stale_lease_id),
        None,
    )
    .map_err(|(status, body)| {
        anyhow::anyhow!("issue stale agent token: {status}: {}", body.0.message)
    })?
    .token;
    let app = runtime::router().with_state(build_test_state(pool.clone(), config));
    let stop_payload = json!({
        "runtime_id": runtime_id,
        "require_provider_release": true,
        "expected_project_id": project_id,
        "expected_provider": provider_id,
    });

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/stop")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {agent_token}"),
                )
                .body(Body::from(serde_json::to_vec(&stop_payload)?))?,
        )
        .await?;
    assert_eq!(first.status(), StatusCode::BAD_GATEWAY);
    let first_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(first.into_body(), usize::MAX).await?)?;
    assert_eq!(first_body["ok"], false);
    assert_eq!(first_body["status_changed"], false);
    assert_eq!(first_body["provider_release_attempted"], true);
    assert_eq!(first_body["provider_release_succeeded"], false);
    assert_eq!(first_body["skip_reason"], "provider_cleanup_pending");

    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status, active_lease_id FROM runtimes WHERE id = $1",
                &[&runtime_id],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "requested");
        assert_eq!(
            runtime_row.get::<_, Option<Uuid>>("active_lease_id"),
            Some(lease_id)
        );
        let lease_status: String = connection
            .query_one(
                "SELECT status FROM runtime_leases WHERE id = $1",
                &[&lease_id],
            )
            .await?
            .get(0);
        assert_eq!(lease_status, "cleanup_pending");
    }

    let stale_retry = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/stop")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {stale_agent_token}"),
                )
                .body(Body::from(serde_json::to_vec(&stop_payload)?))?,
        )
        .await?;
    assert_eq!(stale_retry.status(), StatusCode::UNAUTHORIZED);
    let stale_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(stale_retry.into_body(), usize::MAX).await?)?;
    assert_eq!(
        stale_body["message"],
        json!("agent token runtime lease scope is no longer active")
    );

    let second = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/stop")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {agent_token}"),
                )
                .body(Body::from(serde_json::to_vec(&stop_payload)?))?,
        )
        .await?;
    assert_eq!(second.status(), StatusCode::OK);
    let second_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(second.into_body(), usize::MAX).await?)?;
    assert_eq!(second_body["ok"], true);
    assert_eq!(second_body["status_changed"], true);
    assert!(second_body.get("skip_reason").is_none());
    assert_eq!(second_body["provider_release_attempted"], true);
    assert_eq!(second_body["provider_release_succeeded"], true);
    assert_eq!(release_calls.load(Ordering::SeqCst), 2);

    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status, active_lease_id FROM runtimes WHERE id = $1",
                &[&runtime_id],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "stopped");
        assert_eq!(runtime_row.get::<_, Option<Uuid>>("active_lease_id"), None);
        let lease_row = connection
            .query_one(
                "SELECT status, released_at IS NOT NULL AS released FROM runtime_leases WHERE id = $1",
                &[&lease_id],
            )
            .await?;
        assert_eq!(lease_row.get::<_, String>("status"), "released");
        assert!(lease_row.get::<_, bool>("released"));
    }

    provider_handle.abort();
    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn strict_runtime_stop_accepts_removed_runtime_only_with_newer_provider_ack(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("removed strict runtime stop retry test").await?;

    let release_calls = Arc::new(AtomicUsize::new(0));
    let provider_app = axum::Router::new().route(
        "/runtime/release",
        axum::routing::post({
            let release_calls = release_calls.clone();
            move || {
                let release_calls = release_calls.clone();
                async move {
                    release_calls.fetch_add(1, Ordering::SeqCst);
                    StatusCode::NO_CONTENT
                }
            }
        }),
    );
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider_listener.local_addr()?;
    let provider_handle = tokio::spawn(async move {
        axum::serve(provider_listener, provider_app)
            .await
            .expect("serve removed retry test provider");
    });

    let project_id = Uuid::new_v4();
    let acknowledged_runtime_id = Uuid::new_v4();
    let missing_ack_runtime_id = Uuid::new_v4();
    let stale_ack_runtime_id = Uuid::new_v4();
    let wrong_provider_ack_runtime_id = Uuid::new_v4();
    let wrong_lease_ack_runtime_id = Uuid::new_v4();
    let malformed_ack_runtime_id = Uuid::new_v4();
    let acknowledged_lease_id = Uuid::new_v4();
    let missing_ack_lease_id = Uuid::new_v4();
    let stale_ack_lease_id = Uuid::new_v4();
    let wrong_provider_ack_lease_id = Uuid::new_v4();
    let wrong_lease_ack_lease_id = Uuid::new_v4();
    let malformed_ack_lease_id = Uuid::new_v4();
    let stale_bound_job_id = Uuid::new_v4();
    let provider_id = "removed_strict_retry_test";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'deleted')",
                &[&project_id],
            )
            .await?;
        for runtime_id in [
            acknowledged_runtime_id,
            missing_ack_runtime_id,
            stale_ack_runtime_id,
            wrong_provider_ack_runtime_id,
            wrong_lease_ack_runtime_id,
            malformed_ack_runtime_id,
        ] {
            connection
                .execute(
                    "INSERT INTO runtimes (
                         id, project_id, provider, status, idle_ttl_seconds, updated_at
                     ) VALUES ($1, $2, $3, 'removed', 600, now())",
                    &[&runtime_id, &project_id, &provider_id],
                )
                .await?;
        }
        for (lease_id, runtime_id) in [
            (acknowledged_lease_id, acknowledged_runtime_id),
            (missing_ack_lease_id, missing_ack_runtime_id),
            (stale_ack_lease_id, stale_ack_runtime_id),
            (wrong_provider_ack_lease_id, wrong_provider_ack_runtime_id),
            (wrong_lease_ack_lease_id, wrong_lease_ack_runtime_id),
            (malformed_ack_lease_id, malformed_ack_runtime_id),
        ] {
            connection
                .execute(
                    "INSERT INTO runtime_leases (
                         id, project_id, runtime_id, status, requested_at, launched_at, released_at
                     ) VALUES ($1, $2, $3, 'released', now(), now(), now())",
                    &[&lease_id, &project_id, &runtime_id],
                )
                .await?;
        }

        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES ($1, $2, 'stopped', '{}'::jsonb)",
                &[&acknowledged_runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES (
                     $1, $2, 'provider_release_acknowledged',
                     jsonb_build_object(
                         'provider', replace($3::text, '_', '-'),
                         'runtimeLeaseId', $4::text
                     )
                 )",
                &[
                    &acknowledged_runtime_id,
                    &project_id,
                    &provider_id,
                    &acknowledged_lease_id.to_string(),
                ],
            )
            .await?;

        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES ($1, $2, 'stopped', '{}'::jsonb)",
                &[&missing_ack_runtime_id, &project_id],
            )
            .await?;

        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES (
                     $1, $2, 'provider_release_acknowledged',
                     jsonb_build_object('provider', $3::text, 'runtimeLeaseId', $4::text)
                 )",
                &[
                    &stale_ack_runtime_id,
                    &project_id,
                    &provider_id,
                    &stale_ack_lease_id.to_string(),
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES ($1, $2, 'stopped', '{}'::jsonb)",
                &[&stale_ack_runtime_id, &project_id],
            )
            .await?;

        for runtime_id in [
            wrong_provider_ack_runtime_id,
            wrong_lease_ack_runtime_id,
            malformed_ack_runtime_id,
        ] {
            connection
                .execute(
                    "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                     VALUES ($1, $2, 'stopped', '{}'::jsonb)",
                    &[&runtime_id, &project_id],
                )
                .await?;
        }
        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES (
                     $1, $2, 'provider_release_acknowledged',
                     jsonb_build_object('provider', 'different-provider', 'runtimeLeaseId', $3::text)
                 )",
                &[
                    &wrong_provider_ack_runtime_id,
                    &project_id,
                    &wrong_provider_ack_lease_id.to_string(),
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES (
                     $1, $2, 'provider_release_acknowledged',
                     jsonb_build_object('provider', $3::text, 'runtimeLeaseId', $4::text)
                 )",
                &[
                    &wrong_lease_ack_runtime_id,
                    &project_id,
                    &provider_id,
                    &acknowledged_lease_id.to_string(),
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_events (runtime_id, project_id, kind, data)
                 VALUES (
                     $1, $2, 'provider_release_acknowledged',
                     jsonb_build_object('provider', $3::text, 'runtimeLeaseId', 'not-a-uuid')
                 )",
                &[&malformed_ack_runtime_id, &project_id, &provider_id],
            )
            .await?;

        connection
            .execute(
                "INSERT INTO agent_jobs (
                     id, project_id, conversation_id, status, payload, priority,
                     leased_by_runtime_id, leased_at, lease_expires_at, target_runtime_id
                 ) VALUES (
                     $1, $2, NULL, 'leased', $3, 10, $4, now(),
                     now() + interval '10 minutes', $4
                 )",
                &[
                    &stale_bound_job_id,
                    &project_id,
                    &PgJson(json!({ "prompt_text": "stale terminal runtime job" })),
                    &acknowledged_runtime_id,
                ],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "removed-strict-runtime-stop-retry",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: provider_id.to_string(),
        display_name: "Removed strict retry test provider".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    }];
    let app = runtime::router().with_state(build_test_state(pool.clone(), config));

    for mismatched_expectation in [
        json!({
            "expected_project_id": Uuid::new_v4(),
            "expected_provider": provider_id,
        }),
        json!({
            "expected_project_id": project_id,
            "expected_provider": "different-provider",
        }),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/stop")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        "Bearer service-role-token",
                    )
                    .body(Body::from(serde_json::to_vec(&json!({
                        "runtime_id": acknowledged_runtime_id,
                        "require_provider_release": true,
                        "expected_project_id": mismatched_expectation["expected_project_id"],
                        "expected_provider": mismatched_expectation["expected_provider"],
                    }))?))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    for expected_status_changed in [true, false] {
        let acknowledged = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/stop")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        "Bearer service-role-token",
                    )
                    .body(Body::from(serde_json::to_vec(&json!({
                        "runtime_id": acknowledged_runtime_id,
                        "require_provider_release": true,
                        "expected_project_id": project_id,
                    }))?))?,
            )
            .await?;
        assert_eq!(acknowledged.status(), StatusCode::OK);
        let acknowledged_body: serde_json::Value =
            serde_json::from_slice(&to_bytes(acknowledged.into_body(), usize::MAX).await?)?;
        assert_eq!(acknowledged_body["ok"], true);
        assert_eq!(acknowledged_body["status_changed"], expected_status_changed);
        assert_eq!(acknowledged_body["skip_reason"], "already_stopped");
        assert_eq!(acknowledged_body["provider_release_attempted"], true);
        assert_eq!(acknowledged_body["provider_release_succeeded"], true);
    }

    for runtime_id in [
        missing_ack_runtime_id,
        stale_ack_runtime_id,
        wrong_provider_ack_runtime_id,
        wrong_lease_ack_runtime_id,
        malformed_ack_runtime_id,
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/stop")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        "Bearer service-role-token",
                    )
                    .body(Body::from(serde_json::to_vec(&json!({
                        "runtime_id": runtime_id,
                        "require_provider_release": true,
                        "expected_project_id": project_id,
                        "expected_provider": provider_id,
                    }))?))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        assert_eq!(
            body["message"],
            "strict provider release cannot be proven for this terminal runtime"
        );
    }

    assert_eq!(release_calls.load(Ordering::SeqCst), 0);
    let connection = pool.get().await?;
    let stale_job = connection
        .query_one(
            "SELECT status, leased_by_runtime_id, target_runtime_id
             FROM agent_jobs WHERE id = $1",
            &[&stale_bound_job_id],
        )
        .await?;
    assert_eq!(stale_job.get::<_, String>("status"), "queued");
    assert_eq!(
        stale_job.get::<_, Option<Uuid>>("leased_by_runtime_id"),
        None
    );
    assert_eq!(stale_job.get::<_, Option<Uuid>>("target_runtime_id"), None);
    let acknowledged_stopped_events: i64 = connection
        .query_one(
            "SELECT count(*) FROM runtime_events
             WHERE runtime_id = $1 AND kind = 'stopped'",
            &[&acknowledged_runtime_id],
        )
        .await?
        .get(0);
    assert_eq!(acknowledged_stopped_events, 1);
    let remaining_removed: i64 = connection
        .query_one(
            "SELECT count(*) FROM runtimes
             WHERE project_id = $1 AND status = 'removed' AND active_lease_id IS NULL",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(remaining_removed, 6);
    drop(connection);

    provider_handle.abort();
    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn service_role_strict_runtime_stop_releases_after_project_tombstone() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("tombstoned project runtime stop test").await?;

    let release_calls = Arc::new(AtomicUsize::new(0));
    let provider_app = axum::Router::new().route(
        "/runtime/release",
        axum::routing::post({
            let release_calls = release_calls.clone();
            move || {
                let release_calls = release_calls.clone();
                async move {
                    release_calls.fetch_add(1, Ordering::SeqCst);
                    StatusCode::NO_CONTENT
                }
            }
        }),
    );
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider_listener.local_addr()?;
    let provider_handle = tokio::spawn(async move {
        axum::serve(provider_listener, provider_app)
            .await
            .expect("serve tombstoned project release test provider");
    });

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let provider_id = "tombstoned_project_release_test";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'deleted')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, updated_at
                 ) VALUES ($1, $2, $3, 'ready', 'http://runtime', 'provider-task', 600, now(), now())",
                &[&runtime_id, &project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) VALUES ($1, $2, $3, 'active', now(), now())",
                &[&lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "tombstoned-project-runtime-stop",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: provider_id.to_string(),
        display_name: "Tombstoned project release test provider".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    }];
    let app = runtime::router().with_state(build_test_state(pool.clone(), config));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/stop")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::from(serde_json::to_vec(&json!({
                    "runtime_id": runtime_id,
                    "require_provider_release": true,
                    "expected_project_id": project_id,
                    "expected_provider": provider_id,
                }))?))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    assert_eq!(body["ok"], true);
    assert_eq!(body["status_changed"], true);
    assert_eq!(body["provider_release_attempted"], true);
    assert_eq!(body["provider_release_succeeded"], true);
    assert_eq!(release_calls.load(Ordering::SeqCst), 1);

    let connection = pool.get().await?;
    let row = connection
        .query_one(
            "select status, active_lease_id from runtimes where id = $1",
            &[&runtime_id],
        )
        .await?;
    assert_eq!(row.get::<_, String>("status"), "stopped");
    assert_eq!(row.get::<_, Option<Uuid>>("active_lease_id"), None);
    drop(connection);

    provider_handle.abort();
    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn service_role_strict_runtime_stop_accepts_private_self_hosted_without_provider_release(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("private self-hosted strict stop test").await?;

    let project_id = Uuid::new_v4();
    let active_runtime_id = Uuid::new_v4();
    let stopped_runtime_id = Uuid::new_v4();
    let mismatched_runtime_id = Uuid::new_v4();
    let unknown_provider_runtime_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let mut capabilities = json!({
        "agent": true,
        "personalBrowser": {
            "enabled": true,
            "ownerUserId": owner_user_id.to_string(),
        },
    });
    crate::runtime::set_self_hosted_access_attestation(
        capabilities
            .as_object_mut()
            .expect("test capabilities are an object"),
        owner_user_id,
    );

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status)
                 VALUES ($1, 'customer', 'deleted')",
                &[&project_id],
            )
            .await?;
        for (runtime_id, status) in [
            (active_runtime_id, "ready"),
            (stopped_runtime_id, "stopped"),
            (mismatched_runtime_id, "ready"),
        ] {
            connection
                .execute(
                    "INSERT INTO runtimes (
                         id, project_id, provider, status, endpoint_url, task_ref,
                         idle_ttl_seconds, last_seen_at, capabilities, updated_at
                     ) VALUES (
                         $1, $2, 'self-hosted', $3, 'http://runtime.invalid',
                         $4, 600, now(), $5, now()
                     )",
                    &[
                        &runtime_id,
                        &project_id,
                        &status,
                        &format!("private-personal-{runtime_id}"),
                        &capabilities,
                    ],
                )
                .await?;
        }
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities, updated_at
                 ) VALUES (
                     $1, $2, 'removed-custom-provider', 'ready',
                     'http://runtime.invalid', $3, 600, now(), '{}'::jsonb, now()
                 )",
                &[
                    &unknown_provider_runtime_id,
                    &project_id,
                    &format!("unknown-provider-{unknown_provider_runtime_id}"),
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "private-self-hosted-strict-stop",
    );
    let app = runtime::router().with_state(build_test_state(pool.clone(), config));

    for (runtime_id, expected_status_changed, expected_skip_reason) in [
        (active_runtime_id, true, None),
        (stopped_runtime_id, false, Some("already_stopped")),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/stop")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        "Bearer service-role-token",
                    )
                    .body(Body::from(serde_json::to_vec(&json!({
                        "runtime_id": runtime_id,
                        "require_provider_release": true,
                        "expected_project_id": project_id,
                        "expected_provider": "self-hosted",
                    }))?))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        assert_eq!(body["ok"], true);
        assert_eq!(body["status_changed"], expected_status_changed);
        assert_eq!(body["provider_release_attempted"], false);
        assert_eq!(body["provider_release_succeeded"], true);
        match expected_skip_reason {
            Some(reason) => assert_eq!(body["skip_reason"], reason),
            None => assert!(body.get("skip_reason").is_none()),
        }
    }

    let mismatched_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/stop")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::from(serde_json::to_vec(&json!({
                    "runtime_id": mismatched_runtime_id,
                    "require_provider_release": true,
                    "expected_project_id": project_id,
                    "expected_provider": "self-hosted",
                    "expected_display_name": "different-runtime",
                }))?))?,
        )
        .await?;
    assert_eq!(mismatched_response.status(), StatusCode::BAD_GATEWAY);
    let mismatched_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(mismatched_response.into_body(), usize::MAX).await?)?;
    assert_eq!(mismatched_body["ok"], false);
    assert_eq!(mismatched_body["status_changed"], false);
    assert_eq!(mismatched_body["provider_release_attempted"], false);
    assert_eq!(mismatched_body["provider_release_succeeded"], false);
    assert_eq!(mismatched_body["skip_reason"], "runtime_identity_mismatch");

    let unknown_provider_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/stop")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    "Bearer service-role-token",
                )
                .body(Body::from(serde_json::to_vec(&json!({
                    "runtime_id": unknown_provider_runtime_id,
                    "require_provider_release": true,
                    "expected_project_id": project_id,
                    "expected_provider": "removed-custom-provider",
                }))?))?,
        )
        .await?;
    assert_eq!(unknown_provider_response.status(), StatusCode::CONFLICT);

    let connection = pool.get().await?;
    let remaining_active: i64 = connection
        .query_one(
            "SELECT count(*) FROM runtimes
             WHERE project_id = $1 AND status <> 'stopped'",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(remaining_active, 2);
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn runtime_stop_fails_browser_bound_jobs_without_unpinning_them() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping browser-bound runtime stop test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    create_runtime_tables(&mut client).await?;

    let runtime_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let normal_job_id = Uuid::new_v4();
    let personal_leased_job_id = Uuid::new_v4();
    let personal_queued_job_id = Uuid::new_v4();
    let personal_leased_run_id = Uuid::new_v4();
    let personal_queued_run_id = Uuid::new_v4();
    let shared_leased_job_id = Uuid::new_v4();
    let shared_queued_job_id = Uuid::new_v4();
    let shared_leased_run_id = Uuid::new_v4();
    let shared_queued_run_id = Uuid::new_v4();
    let normal_payload = PgJson(json!({ "prompt_text": "ordinary remote work" }));
    let personal_leased_payload = PgJson(json!({
        "prompt_text": "continue in my browser",
        "metadata": { "browserTransport": "desktop-personal" }
    }));
    let personal_queued_payload = PgJson(json!({
        "prompt_text": "open another signed-in page",
        "metadata": { "browser_transport": "desktop_personal" }
    }));
    let shared_leased_payload = PgJson(json!({
        "prompt_text": "continue on the visible shared page",
        "metadata": { "browserTransport": "shared" }
    }));
    let shared_queued_payload = PgJson(json!({
        "prompt_text": "click the visible shared button",
        "metadata": { "browser_transport": "shared" }
    }));

    client
        .execute(
            "INSERT INTO runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at
             ) VALUES (
                 $1, $2, 'desktop', 'ready', 'http://example', 'desktop-task',
                 600, now() - interval '1 hour'
             )",
            &[&runtime_id, &project_id],
        )
        .await?;

    client
        .execute(
            "INSERT INTO runs (id, project_id, status, progress, progress_stage)
             VALUES ($1, $3, 'in_progress', 40, 'agent:leased'),
                    ($2, $3, 'queued', 0, 'agent:queued')",
            &[
                &personal_leased_run_id,
                &personal_queued_run_id,
                &project_id,
            ],
        )
        .await?;

    client
        .execute(
            "INSERT INTO runs (id, project_id, status, progress, progress_stage)
             VALUES ($1, $3, 'in_progress', 55, 'agent:leased'),
                    ($2, $3, 'queued', 0, 'agent:queued')",
            &[&shared_leased_run_id, &shared_queued_run_id, &project_id],
        )
        .await?;

    client
        .execute(
            "INSERT INTO agent_jobs (
                 id, project_id, run_id, status, payload, priority,
                 target_runtime_id, leased_by_runtime_id, leased_at, lease_expires_at
             ) VALUES
                 ($1, $2, NULL, 'leased', $3, 10, $4, $4, now(), now() + interval '10 minutes'),
                 ($5, $2, $6, 'leased', $7, 20, $4, $4, now(), now() + interval '10 minutes'),
                 ($8, $2, $9, 'queued', $10, 30, $4, NULL, NULL, NULL)",
            &[
                &normal_job_id,
                &project_id,
                &normal_payload,
                &runtime_id,
                &personal_leased_job_id,
                &personal_leased_run_id,
                &personal_leased_payload,
                &personal_queued_job_id,
                &personal_queued_run_id,
                &personal_queued_payload,
            ],
        )
        .await?;

    client
        .execute(
            "INSERT INTO agent_jobs (
                 id, project_id, run_id, status, payload, priority,
                 target_runtime_id, leased_by_runtime_id, leased_at, lease_expires_at
             ) VALUES
                 ($1, $2, $3, 'leased', $4, 40, $5, $5, now(), now() + interval '10 minutes'),
                 ($6, $2, $7, 'queued', $8, 50, $5, NULL, NULL, NULL)",
            &[
                &shared_leased_job_id,
                &project_id,
                &shared_leased_run_id,
                &shared_leased_payload,
                &runtime_id,
                &shared_queued_job_id,
                &shared_queued_run_id,
                &shared_queued_payload,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("fetch Personal Browser runtime", error))?;
    let outcome = runtime::perform_runtime_stop(
        &transaction,
        &runtime,
        runtime::StopOptions {
            source: "test",
            reason: Some("desktop_disconnected".to_string()),
            skip_if_active_jobs: false,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await
    .map_err(|error| controller_error("stop Personal Browser runtime", error))?;
    assert_eq!(outcome.requeued_jobs, vec![normal_job_id]);
    assert_eq!(outcome.failed_personal_browser_jobs.len(), 2);
    assert!(outcome
        .failed_personal_browser_jobs
        .contains(&personal_leased_job_id));
    assert!(outcome
        .failed_personal_browser_jobs
        .contains(&personal_queued_job_id));
    assert_eq!(outcome.failed_shared_browser_jobs.len(), 2);
    assert!(outcome
        .failed_shared_browser_jobs
        .contains(&shared_leased_job_id));
    assert!(outcome
        .failed_shared_browser_jobs
        .contains(&shared_queued_job_id));
    transaction.commit().await?;

    let normal_row = client
        .query_one(
            "SELECT status, target_runtime_id, leased_by_runtime_id
             FROM agent_jobs WHERE id = $1",
            &[&normal_job_id],
        )
        .await?;
    assert_eq!(normal_row.get::<_, String>("status"), "queued");
    assert!(normal_row
        .get::<_, Option<Uuid>>("target_runtime_id")
        .is_none());
    assert!(normal_row
        .get::<_, Option<Uuid>>("leased_by_runtime_id")
        .is_none());

    for job_id in [personal_leased_job_id, personal_queued_job_id] {
        let row = client
            .query_one(
                "SELECT status, outcome, summary, error_message, target_runtime_id,
                        leased_by_runtime_id, completed_at
                 FROM agent_jobs WHERE id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "failed");
        assert_eq!(
            row.get::<_, Option<String>>("outcome").as_deref(),
            Some("failed")
        );
        assert_eq!(
            row.get::<_, Option<String>>("summary").as_deref(),
            Some(runtime::PERSONAL_BROWSER_DISCONNECTED_ERROR)
        );
        assert_eq!(
            row.get::<_, Option<String>>("error_message").as_deref(),
            Some(runtime::PERSONAL_BROWSER_DISCONNECTED_ERROR)
        );
        assert_eq!(
            row.get::<_, Option<Uuid>>("target_runtime_id"),
            Some(runtime_id)
        );
        assert!(row.get::<_, Option<Uuid>>("leased_by_runtime_id").is_none());
        assert!(row
            .get::<_, Option<chrono::DateTime<Utc>>>("completed_at")
            .is_some());
    }

    for run_id in [personal_leased_run_id, personal_queued_run_id] {
        let row = client
            .query_one(
                "SELECT status, progress, progress_stage, last_message
                 FROM runs WHERE id = $1",
                &[&run_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "failed");
        assert_eq!(row.get::<_, f64>("progress"), 100.0);
        assert!(row.get::<_, Option<String>>("progress_stage").is_none());
        assert_eq!(
            row.get::<_, Option<String>>("last_message").as_deref(),
            Some(runtime::PERSONAL_BROWSER_DISCONNECTED_ERROR)
        );
    }

    for job_id in [shared_leased_job_id, shared_queued_job_id] {
        let row = client
            .query_one(
                "SELECT status, outcome, summary, error_message, target_runtime_id,
                        leased_by_runtime_id, completed_at
                 FROM agent_jobs WHERE id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "failed");
        assert_eq!(
            row.get::<_, Option<String>>("outcome").as_deref(),
            Some("failed")
        );
        assert_eq!(
            row.get::<_, Option<String>>("summary").as_deref(),
            Some(runtime::SHARED_BROWSER_DISCONNECTED_ERROR)
        );
        assert_eq!(
            row.get::<_, Option<String>>("error_message").as_deref(),
            Some(runtime::SHARED_BROWSER_DISCONNECTED_ERROR)
        );
        assert_eq!(
            row.get::<_, Option<Uuid>>("target_runtime_id"),
            Some(runtime_id)
        );
        assert!(row.get::<_, Option<Uuid>>("leased_by_runtime_id").is_none());
        assert!(row
            .get::<_, Option<chrono::DateTime<Utc>>>("completed_at")
            .is_some());
    }

    for run_id in [shared_leased_run_id, shared_queued_run_id] {
        let row = client
            .query_one(
                "SELECT status, progress, progress_stage, last_message
                 FROM runs WHERE id = $1",
                &[&run_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "failed");
        assert_eq!(row.get::<_, f64>("progress"), 100.0);
        assert!(row.get::<_, Option<String>>("progress_stage").is_none());
        assert_eq!(
            row.get::<_, Option<String>>("last_message").as_deref(),
            Some(runtime::SHARED_BROWSER_DISCONNECTED_ERROR)
        );
    }

    let disconnect_event = client
        .query_one(
            "SELECT data FROM runtime_events
             WHERE runtime_id = $1 AND kind = 'personal_browser_disconnected'",
            &[&runtime_id],
        )
        .await?
        .get::<_, PgJson<serde_json::Value>>("data")
        .0;
    assert_eq!(
        disconnect_event
            .get("error")
            .and_then(serde_json::Value::as_str),
        Some(runtime::PERSONAL_BROWSER_DISCONNECTED_ERROR)
    );
    assert_eq!(
        disconnect_event
            .get("job_count")
            .and_then(serde_json::Value::as_u64),
        Some(2)
    );
    assert!(disconnect_event.get("job_ids").is_none());
    assert!(disconnect_event.get("run_ids").is_none());

    let shared_disconnect_event = client
        .query_one(
            "SELECT data FROM runtime_events
             WHERE runtime_id = $1 AND kind = 'shared_browser_disconnected'",
            &[&runtime_id],
        )
        .await?
        .get::<_, PgJson<serde_json::Value>>("data")
        .0;
    assert_eq!(
        shared_disconnect_event
            .get("error")
            .and_then(serde_json::Value::as_str),
        Some(runtime::SHARED_BROWSER_DISCONNECTED_ERROR)
    );
    assert_eq!(
        shared_disconnect_event
            .get("job_count")
            .and_then(serde_json::Value::as_u64),
        Some(2)
    );
    assert!(shared_disconnect_event.get("job_ids").is_none());
    assert!(shared_disconnect_event.get("run_ids").is_none());

    // A dispatch racing just behind the first stop can only become visible
    // after the runtime is already terminal. Repeating stop must still fail
    // the newly pinned Personal Browser job instead of short-circuiting.
    let raced_job_id = Uuid::new_v4();
    let raced_run_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, project_id, status, progress, progress_stage)
             VALUES ($1, $2, 'queued', 0, 'agent:queued')",
            &[&raced_run_id, &project_id],
        )
        .await?;
    client
        .execute(
            "INSERT INTO agent_jobs (
                 id, project_id, run_id, status, payload, priority, target_runtime_id
             ) VALUES ($1, $2, $3, 'queued', $4, 10, $5)",
            &[
                &raced_job_id,
                &project_id,
                &raced_run_id,
                &personal_queued_payload,
                &runtime_id,
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    let stopped_runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("fetch stopped Personal Browser runtime", error))?;
    let repeated = runtime::perform_runtime_stop(
        &transaction,
        &stopped_runtime,
        runtime::StopOptions {
            source: "test_idempotent",
            reason: Some("desktop_disconnected".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await
    .map_err(|error| controller_error("repeat Personal Browser stop", error))?;
    assert!(repeated.status_changed);
    assert_eq!(repeated.failed_personal_browser_jobs, vec![raced_job_id]);
    transaction.commit().await?;

    let raced_job_status: String = client
        .query_one(
            "SELECT status FROM agent_jobs WHERE id = $1",
            &[&raced_job_id],
        )
        .await?
        .get(0);
    assert_eq!(raced_job_status, "failed");

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn operator_project_search_matches_member_email_and_prioritizes_direct_project_access(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping operator project search test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let org_id = Uuid::new_v4();
    let search_user_id = Uuid::new_v4();
    let target_project_id = Uuid::new_v4();
    let org_only_project_ids = (0..12).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    let search_email = format!("controller-test+{}@example.com", search_user_id);

    let result = async {
        ensure_test_user(&pool, &search_user_id).await?;

        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("operator-search-{org_id}"),
                    &"Operator Search Org",
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, 'builder')",
                &[&org_id, &search_user_id],
            )
            .await?;

        for (index, project_id) in org_only_project_ids.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO projects (id, org_id, name, project_type, status)
                     VALUES ($1, $2, $3, 'customer', 'active')",
                    &[project_id, &org_id, &format!("Org Project {index:02}")],
                )
                .await?;
        }

        connection
            .execute(
                "INSERT INTO projects (id, org_id, name, project_type, status)
                 VALUES ($1, $2, $3, 'customer', 'active')",
                &[&target_project_id, &org_id, &"Target Shared Project"],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO project_memberships (project_id, user_id, role)
                 VALUES ($1, $2, 'builder')",
                &[&target_project_id, &search_user_id],
            )
            .await?;

        let state = build_test_state(
            pool.clone(),
            build_app_config(
                test_origin_private_key(),
                test_origin_public_key(),
                "operator-search-membership",
            ),
        );

        let response = crate::operator_admin::router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/operator/projects/search?q={}&limit=10",
                        urlencoding::encode(&search_email)
                    ))
                    .header("authorization", "Bearer service-role-token")
                    .body(Body::empty())?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        let payload: serde_json::Value = serde_json::from_slice(&body)?;
        let projects = payload["projects"].as_array().cloned().unwrap_or_default();

        assert_eq!(
            projects.len(),
            10,
            "expected org-member matches to fill the page"
        );
        assert_eq!(
            projects
                .first()
                .and_then(|project| project.get("projectId"))
                .and_then(|value| value.as_str()),
            Some(target_project_id.to_string().as_str()),
            "direct project membership should rank above broad org membership matches"
        );
        assert!(
            projects.iter().any(|project| {
                project.get("projectId").and_then(|value| value.as_str())
                    == Some(target_project_id.to_string().as_str())
            }),
            "target project should be returned when searching by member email"
        );

        Ok::<(), anyhow::Error>(())
    }
    .await;

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &search_user_id).await?;

    result
}

#[tokio::test]
async fn operator_project_search_prioritizes_recent_exact_owner_activity() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping operator owner activity search test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let org_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let target_project_id = Uuid::new_v4();
    let newer_project_ids = (0..12).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    let owner_email = format!("controller-test+{}@example.com", owner_user_id);
    let now = chrono::Utc::now();

    let result = async {
        ensure_test_user(&pool, &owner_user_id).await?;

        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("operator-owner-search-{org_id}"),
                    &"Operator Owner Search Org",
                ],
            )
            .await?;

        connection
            .execute(
                "INSERT INTO projects (id, org_id, name, project_type, owner_user_id, status, created_at, updated_at)
                 VALUES ($1, $2, $3, 'customer', $4, 'active', $5, $5)",
                &[
                    &target_project_id,
                    &org_id,
                    &"Current Active Project",
                    &owner_user_id,
                    &(now - chrono::Duration::days(30)),
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO conversations (id, project_id, created_by, updated_at)
                 VALUES ($1, $2, $3, $4)",
                &[&Uuid::new_v4(), &target_project_id, &owner_user_id, &now],
            )
            .await?;

        for (index, project_id) in newer_project_ids.iter().enumerate() {
            let created_at = now - chrono::Duration::days(29 - index as i64);
            let conversation_updated_at = now - chrono::Duration::days(60 + index as i64);
            connection
                .execute(
                    "INSERT INTO projects (id, org_id, name, project_type, owner_user_id, status, created_at, updated_at)
                     VALUES ($1, $2, $3, 'customer', $4, 'active', $5, $5)",
                    &[
                        project_id,
                        &org_id,
                        &format!("Older Active Project {index:02}"),
                        &owner_user_id,
                        &created_at,
                    ],
                )
                .await?;
            connection
                .execute(
                    "INSERT INTO conversations (id, project_id, created_by, updated_at)
                     VALUES ($1, $2, $3, $4)",
                    &[&Uuid::new_v4(), project_id, &owner_user_id, &conversation_updated_at],
                )
                .await?;
        }

        let state = build_test_state(
            pool.clone(),
            build_app_config(
                test_origin_private_key(),
                test_origin_public_key(),
                "operator-search-owner-activity",
            ),
        );

        let response = crate::operator_admin::router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/operator/projects/search?q={}&limit=10",
                        urlencoding::encode(&owner_email)
                    ))
                    .header("authorization", "Bearer service-role-token")
                    .body(Body::empty())?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        let payload: serde_json::Value = serde_json::from_slice(&body)?;
        let projects = payload["projects"].as_array().cloned().unwrap_or_default();

        assert_eq!(
            projects
                .first()
                .and_then(|project| project.get("projectId"))
                .and_then(|value| value.as_str()),
            Some(target_project_id.to_string().as_str()),
            "recent owner activity should rank ahead of newer UUIDs",
        );
        assert!(
            projects.iter().any(|project| {
                project.get("projectId").and_then(|value| value.as_str())
                    == Some(target_project_id.to_string().as_str())
            }),
            "current active project should stay visible on the first page",
        );

        Ok::<(), anyhow::Error>(())
    }
    .await;

    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;

    result
}

#[tokio::test]
async fn runtime_stop_skips_when_active_jobs_and_skip_flag() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping runtime skip test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    create_runtime_tables(&mut client).await?;

    let runtime_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let payload = PgJson(json!({ "prompt_text": "active" }));

    client
        .execute(
            "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
             VALUES ($1, $2, 'self-hosted', 'ready', 600, now() - interval '1 hour')",
            &[&runtime_id, &project_id],
        )
        .await?;

    client
        .execute(
            "INSERT INTO agent_jobs (id, project_id, conversation_id, status, payload, priority, leased_by_runtime_id)
             VALUES ($1, $2, NULL, 'leased', $3, 10, $4)",
            &[&job_id, &project_id, &payload, &runtime_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("fetch runtime", error))?;
    let outcome = runtime::perform_runtime_stop(
        &transaction,
        &runtime,
        runtime::StopOptions {
            source: "test",
            reason: None,
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await
    .map_err(|error| controller_error("perform runtime stop", error))?;
    assert!(!outcome.status_changed);
    assert_eq!(outcome.skip_reason.as_deref(), Some("active_jobs"));
    transaction.rollback().await?;

    let runtime_status: String = client
        .query_one("SELECT status FROM runtimes WHERE id = $1", &[&runtime_id])
        .await?
        .get(0);
    assert_eq!(runtime_status, "ready");

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn runtime_safe_stop_stops_idle_runtime() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping idle runtime safe-stop test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    create_runtime_tables(&mut client).await?;

    let runtime_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runtimes (id, project_id, provider, status, endpoint_url, task_ref, idle_ttl_seconds, last_seen_at)
             VALUES ($1, $2, 'self-hosted', 'ready', 'http://example', 'task-safe-stop', 600, now())",
            &[&runtime_id, &project_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("fetch idle runtime", error))?;
    let outcome = runtime::perform_runtime_stop(
        &transaction,
        &runtime,
        runtime::StopOptions {
            source: "test_safe_stop",
            reason: Some("safe_stop".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await
    .map_err(|error| controller_error("perform idle runtime safe stop", error))?;
    assert!(outcome.status_changed);
    assert_eq!(outcome.skip_reason, None);
    transaction.commit().await?;

    let runtime_row = client
        .query_one(
            "SELECT status, endpoint_url, task_ref FROM runtimes WHERE id = $1",
            &[&runtime_id],
        )
        .await?;
    assert_eq!(runtime_row.get::<_, String>("status"), "stopped");
    assert!(runtime_row
        .get::<_, Option<String>>("endpoint_url")
        .is_none());
    assert!(runtime_row.get::<_, Option<String>>("task_ref").is_none());

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn runtime_safe_stop_waits_for_inflight_heartbeat_renewal() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping heartbeat/safe-stop ordering test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let runtime_owner_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status)
                 VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) VALUES (
                     $1, $2, 'self-hosted', 'ready', 'http://example',
                     'task-heartbeat-first', 600, now(), $3
                 )",
                &[
                    &runtime_id,
                    &project_id,
                    &PgJson(json!({
                        "_instafySelfHostedAccess": {
                            "mode": "private",
                            "ownerUserId": runtime_owner_id.to_string(),
                        }
                    })),
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO agent_jobs (
                     id, project_id, status, payload, priority,
                     leased_by_runtime_id, leased_at, lease_expires_at
                 ) VALUES (
                     $1, $2, 'leased', $3, 10, $4,
                     now() - interval '2 minutes', now() - interval '1 second'
                 )",
                &[
                    &job_id,
                    &project_id,
                    &PgJson(json!({ "prompt_text": "renew at the boundary" })),
                    &runtime_id,
                ],
            )
            .await?;
    }

    let mut heartbeat_connection = pool.get().await?;
    let heartbeat_transaction = heartbeat_connection.transaction().await?;
    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "heartbeat-safe-stop-ordering",
        ),
    );
    agent::ensure_runtime_can_heartbeat(
        &state,
        &heartbeat_transaction,
        &project_id,
        &runtime_id,
        None,
        None,
    )
    .await
    .map_err(|error| controller_error("lock runtime for heartbeat", error))?;

    let stop_pool = pool.clone();
    let mut stop_task = tokio::spawn(async move {
        let mut connection = stop_pool.get().await?;
        let transaction = connection.transaction().await?;
        let runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
            .await
            .map_err(|error| controller_error("fetch runtime behind heartbeat", error))?;
        let outcome = runtime::perform_runtime_stop(
            &transaction,
            &runtime,
            runtime::StopOptions {
                source: "test_heartbeat_ordering",
                reason: Some("runtime_limit_takeover".to_string()),
                skip_if_active_jobs: true,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await
        .map_err(|error| controller_error("safe stop behind heartbeat", error))?;
        transaction.commit().await?;
        Ok::<_, anyhow::Error>((outcome.status_changed, outcome.skip_reason))
    });

    assert!(
        timeout(std::time::Duration::from_millis(150), &mut stop_task)
            .await
            .is_err(),
        "safe stop must wait while heartbeat holds the runtime share lock"
    );

    let renewed = heartbeat_transaction
        .execute(
            "UPDATE agent_jobs
             SET heartbeat_at = now(),
                 lease_expires_at = now() + interval '2 minutes'
             WHERE id = $1
               AND project_id = $2
               AND status = 'leased'
               AND leased_by_runtime_id = $3",
            &[&job_id, &project_id, &runtime_id],
        )
        .await?;
    assert_eq!(renewed, 1);
    heartbeat_transaction.commit().await?;

    let (status_changed, skip_reason) =
        timeout(std::time::Duration::from_secs(2), stop_task).await???;
    assert!(!status_changed);
    assert_eq!(skip_reason.as_deref(), Some("active_jobs"));

    let connection = pool.get().await?;
    let runtime_status: String = connection
        .query_one("SELECT status FROM runtimes WHERE id = $1", &[&runtime_id])
        .await?
        .get(0);
    assert_eq!(runtime_status, "ready");
    let job = connection
        .query_one(
            "SELECT status, lease_expires_at > now() AS lease_is_live
             FROM agent_jobs WHERE id = $1",
            &[&job_id],
        )
        .await?;
    assert_eq!(job.get::<_, String>("status"), "leased");
    assert!(job.get::<_, bool>("lease_is_live"));
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn agent_heartbeat_waits_for_safe_stop_then_rejects_renewal() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping safe-stop/heartbeat ordering test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let runtime_generation = Uuid::new_v4();
    let self_hosted_owner_user_id = Uuid::new_v4();
    let mut runtime_capabilities = json!({ "agent": true });
    crate::runtime::set_runtime_generation_capability(
        &mut runtime_capabilities,
        runtime_generation,
    );
    crate::runtime::set_self_hosted_access_attestation(
        runtime_capabilities
            .as_object_mut()
            .expect("test runtime capabilities are an object"),
        self_hosted_owner_user_id,
    );
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status)
                 VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) VALUES (
                     $1, $2, 'self-hosted', 'ready', 'http://example',
                     'task-stop-first', 600, now(), $3
                 )",
                &[&runtime_id, &project_id, &runtime_capabilities],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO agent_jobs (
                     id, project_id, status, payload, priority,
                     leased_by_runtime_id, leased_at, lease_expires_at
                 ) VALUES (
                     $1, $2, 'leased', $3, 10, $4,
                     now() - interval '2 minutes', now() - interval '1 second'
                 )",
                &[
                    &job_id,
                    &project_id,
                    &PgJson(json!({ "prompt_text": "do not renew after stop" })),
                    &runtime_id,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "safe-stop-heartbeat-ordering",
    );
    let agent_token = crate::tokens::mint_scoped_token_with_runtime_generation(
        &config,
        ScopedTokenRequest {
            audience: runtime_id.to_string(),
            subject: "runtime.test".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: vec!["agent.heartbeat".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(120),
        },
        Some(runtime_generation),
    )
    .expect("mint heartbeat token")
    .token;
    let app = agent::router().with_state(build_test_state(pool.clone(), config));

    let mut stop_connection = pool.get().await?;
    let stop_transaction = stop_connection.transaction().await?;
    let runtime = runtime::fetch_runtime_for_update(&stop_transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("lock runtime for safe stop", error))?;

    let request_body = json!({
        "job_id": job_id.to_string(),
        "extend_seconds": 120,
    });
    let mut heartbeat_task = tokio::spawn(async move {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/heartbeat")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {agent_token}"),
                )
                .body(Body::from(request_body.to_string()))
                .expect("build heartbeat request"),
        )
        .await
    });

    assert!(
        timeout(std::time::Duration::from_millis(150), &mut heartbeat_task)
            .await
            .is_err(),
        "heartbeat must wait while safe stop holds the runtime update lock"
    );

    let stop_outcome = runtime::perform_runtime_stop(
        &stop_transaction,
        &runtime,
        runtime::StopOptions {
            source: "test_stop_ordering",
            reason: Some("runtime_limit_takeover".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await
    .map_err(|error| controller_error("safe stop before heartbeat", error))?;
    assert!(stop_outcome.status_changed);
    stop_transaction.commit().await?;

    let response = timeout(std::time::Duration::from_secs(2), heartbeat_task).await???;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response_body = to_bytes(response.into_body(), usize::MAX).await?;
    let response_json: serde_json::Value = serde_json::from_slice(&response_body)?;
    assert_eq!(
        response_json["message"],
        json!("runtime is no longer active")
    );

    let connection = pool.get().await?;
    let runtime_status: String = connection
        .query_one("SELECT status FROM runtimes WHERE id = $1", &[&runtime_id])
        .await?
        .get(0);
    assert_eq!(runtime_status, "stopped");
    let job = connection
        .query_one(
            "SELECT status, leased_by_runtime_id, lease_expires_at, heartbeat_at
             FROM agent_jobs WHERE id = $1",
            &[&job_id],
        )
        .await?;
    assert_eq!(job.get::<_, String>("status"), "queued");
    assert!(job.get::<_, Option<Uuid>>("leased_by_runtime_id").is_none());
    assert!(job
        .get::<_, Option<chrono::DateTime<Utc>>>("lease_expires_at")
        .is_none());
    assert!(job
        .get::<_, Option<chrono::DateTime<Utc>>>("heartbeat_at")
        .is_none());
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn stale_agent_token_cannot_heartbeat_reused_runtime_generation() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping stale agent-token generation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let stale_lease_id = Uuid::new_v4();
    let active_lease_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status)
                 VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at
                 ) VALUES (
                     $1, $2, 'docker', 'ready', 'http://example',
                     'reused-runtime-generation', 600, now()
                 )",
                &[&runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at, released_at
                 ) VALUES ($1, $2, $3, 'released', now(), now(), now())",
                &[&stale_lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) VALUES ($1, $2, $3, 'active', now(), now())",
                &[&active_lease_id, &project_id, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "UPDATE runtimes SET active_lease_id = $2 WHERE id = $1",
                &[&runtime_id, &active_lease_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO agent_jobs (
                     id, project_id, status, payload, priority,
                     leased_by_runtime_id, leased_at, lease_expires_at
                 ) VALUES (
                     $1, $2, 'leased', $3, 10, $4, now(), now() + interval '1 minute'
                 )",
                &[
                    &job_id,
                    &project_id,
                    &PgJson(json!({ "prompt_text": "stale token must not renew" })),
                    &runtime_id,
                ],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "stale-agent-token-generation",
    );
    let stale_token = crate::auth::issue_agent_token(
        &config,
        &project_id,
        &runtime_id,
        Some(&stale_lease_id),
        None,
    )
    .map_err(|(status, body)| {
        anyhow::anyhow!("issue stale agent token: {status}: {}", body.0.message)
    })?
    .token;
    let app = agent::router().with_state(build_test_state(pool.clone(), config));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/heartbeat")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {stale_token}"),
                )
                .body(Body::from(
                    json!({
                        "job_id": job_id.to_string(),
                        "extend_seconds": 120,
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    assert_eq!(
        body["message"],
        json!("agent token runtime lease scope is no longer active")
    );

    let login_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/login")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {stale_token}"),
                )
                .body(Body::from(
                    json!({
                        "projectId": project_id.to_string(),
                        "runtimeType": "self-hosted",
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(login_response.status(), StatusCode::UNAUTHORIZED);
    let login_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(login_response.into_body(), usize::MAX).await?)?;
    assert_eq!(
        login_body["message"],
        json!("agent login requires user or service-role authorization")
    );

    let connection = pool.get().await?;
    let heartbeat_at: Option<chrono::DateTime<chrono::Utc>> = connection
        .query_one(
            "SELECT heartbeat_at FROM agent_jobs WHERE id = $1",
            &[&job_id],
        )
        .await?
        .get(0);
    assert!(
        heartbeat_at.is_none(),
        "stale token must not mutate the job"
    );
    let runtime_count: i64 = connection
        .query_one(
            "SELECT count(*) FROM runtimes WHERE project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(runtime_count, 1, "stale token must not bootstrap a runtime");
    drop(connection);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

#[tokio::test]
async fn runtime_safe_stop_skips_when_locked_identity_no_longer_matches() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping safe-stop identity test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    create_runtime_tables(&mut client).await?;

    let runtime_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runtimes (id, project_id, provider, status, endpoint_url, task_ref, display_name, idle_ttl_seconds, last_seen_at)
             VALUES ($1, $2, 'instafy-cloud', 'ready', 'http://example', 'task-safe-stop-identity', 'Browser session', 600, now())",
            &[&runtime_id, &project_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("fetch identity-changed runtime", error))?;
    let outcome = runtime::perform_runtime_stop(
        &transaction,
        &runtime,
        runtime::StopOptions {
            source: "test_safe_stop_identity",
            reason: Some("safe_stop".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: Some(runtime::RuntimeIdentityExpectation {
                project_id: Some(project_id),
                provider: Some("instafy-cloud".to_string()),
                display_name: Some("Hosted Runtime".to_string()),
            }),
        },
    )
    .await
    .map_err(|error| controller_error("perform identity-guarded safe stop", error))?;
    assert!(!outcome.status_changed);
    assert_eq!(
        outcome.skip_reason.as_deref(),
        Some("runtime_identity_mismatch")
    );
    transaction.commit().await?;

    let runtime_row = client
        .query_one(
            "SELECT status, endpoint_url, task_ref, display_name FROM runtimes WHERE id = $1",
            &[&runtime_id],
        )
        .await?;
    assert_eq!(runtime_row.get::<_, String>("status"), "ready");
    assert_eq!(
        runtime_row
            .get::<_, Option<String>>("endpoint_url")
            .as_deref(),
        Some("http://example")
    );
    assert_eq!(
        runtime_row.get::<_, Option<String>>("task_ref").as_deref(),
        Some("task-safe-stop-identity")
    );
    assert_eq!(
        runtime_row
            .get::<_, Option<String>>("display_name")
            .as_deref(),
        Some("Browser session")
    );

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn persist_run_completion_metadata_merges_provider_and_credit_snapshot() -> anyhow::Result<()>
{
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping run completion metadata test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                metadata jsonb
            );",
        )
        .await?;

    let run_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, metadata) VALUES ($1, $2::jsonb)",
            &[
                &run_id,
                &PgJson(json!({
                    "provider": {
                        "conversation": {
                            "responseId": "resp_existing"
                        }
                    },
                    "custom": true
                })),
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    crate::agent::persist_run_completion_metadata(
        &transaction,
        &run_id,
        Some("openai"),
        None,
        Some(&json!({
            "remainingCredits": 17
        })),
        Some("Final summary"),
        None,
        Some(2),
    )
    .await?;
    transaction.commit().await?;

    let metadata: serde_json::Value = client
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;

    assert_eq!(metadata["provider"]["id"], json!("openai"));
    assert_eq!(
        metadata["provider"]["conversation"]["responseId"],
        json!("resp_existing")
    );
    assert_eq!(metadata["creditSnapshot"]["remainingCredits"], json!(17));
    assert_eq!(metadata["summary"], json!("Final summary"));
    assert_eq!(metadata["artifactsCount"], json!(2));
    assert_eq!(metadata["custom"], json!(true));

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn load_previous_provider_conversation_state_prefers_matching_provider() -> anyhow::Result<()>
{
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping provider conversation state test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                conversation_id uuid,
                metadata jsonb,
                created_at timestamptz not null default now()
            );",
        )
        .await?;

    let conversation_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, conversation_id, metadata, created_at)
             VALUES
               ($1, $3, $4::jsonb, '2026-01-01T00:00:00Z'::timestamptz),
               ($2, $3, $5::jsonb, '2026-01-02T00:00:00Z'::timestamptz)",
            &[
                &Uuid::new_v4(),
                &Uuid::new_v4(),
                &conversation_id,
                &PgJson(json!({
                    "provider": {
                        "id": "openai",
                        "conversation": {
                            "responseId": "resp_openai"
                        }
                    }
                })),
                &PgJson(json!({
                    "provider": {
                        "id": "anthropic",
                        "conversation": {
                            "responseId": "resp_anthropic"
                        }
                    }
                })),
            ],
        )
        .await?;

    let transaction = client.transaction().await?;

    let latest_any = crate::dispatch::load_previous_provider_conversation_state(
        &transaction,
        &conversation_id,
        None,
        None,
        None,
    )
    .await
    .expect("load latest provider conversation state");
    assert_eq!(
        latest_any
            .as_ref()
            .and_then(|value| value.get("responseId"))
            .and_then(serde_json::Value::as_str),
        Some("resp_anthropic")
    );

    let openai_state = crate::dispatch::load_previous_provider_conversation_state(
        &transaction,
        &conversation_id,
        Some("openai"),
        None,
        None,
    )
    .await
    .expect("load openai conversation state");
    assert_eq!(
        openai_state
            .as_ref()
            .and_then(|value| value.get("responseId"))
            .and_then(serde_json::Value::as_str),
        Some("resp_openai")
    );

    let anthropic_state = crate::dispatch::load_previous_provider_conversation_state(
        &transaction,
        &conversation_id,
        Some("anthropic"),
        None,
        None,
    )
    .await
    .expect("load anthropic conversation state");
    assert_eq!(
        anthropic_state
            .as_ref()
            .and_then(|value| value.get("responseId"))
            .and_then(serde_json::Value::as_str),
        Some("resp_anthropic")
    );

    let missing = crate::dispatch::load_previous_provider_conversation_state(
        &transaction,
        &conversation_id,
        Some("google"),
        None,
        None,
    )
    .await
    .expect("load missing provider conversation state");
    assert!(missing.is_none());

    transaction.rollback().await?;
    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn load_previous_provider_conversation_state_stays_within_agent_scope() -> anyhow::Result<()>
{
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping scoped provider conversation state test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                conversation_id uuid,
                metadata jsonb,
                created_at timestamptz not null default now()
            );",
        )
        .await?;

    let conversation_id = Uuid::new_v4();
    let agent_a_id = Uuid::new_v4();
    let agent_b_id = Uuid::new_v4();

    client
        .execute(
            "INSERT INTO runs (id, conversation_id, metadata, created_at)
             VALUES
               ($1, $3, $4::jsonb, '2026-01-01T00:00:00Z'::timestamptz),
               ($2, $3, $5::jsonb, '2026-01-02T00:00:00Z'::timestamptz)",
            &[
                &Uuid::new_v4(),
                &Uuid::new_v4(),
                &conversation_id,
                &PgJson(json!({
                    "agent": {
                        "id": agent_a_id,
                        "handle": "planner"
                    },
                    "provider": {
                        "id": "openai",
                        "conversation": {
                            "responseId": "resp_agent_a"
                        }
                    }
                })),
                &PgJson(json!({
                    "agent": {
                        "id": agent_b_id,
                        "handle": "builder"
                    },
                    "provider": {
                        "id": "openai",
                        "conversation": {
                            "responseId": "resp_agent_b"
                        }
                    }
                })),
            ],
        )
        .await?;

    let transaction = client.transaction().await?;

    let planner_state = crate::dispatch::load_previous_provider_conversation_state(
        &transaction,
        &conversation_id,
        Some("openai"),
        Some(&agent_a_id),
        Some("planner"),
    )
    .await
    .expect("load planner conversation state");
    assert_eq!(
        planner_state
            .as_ref()
            .and_then(|value| value.get("responseId"))
            .and_then(serde_json::Value::as_str),
        Some("resp_agent_a")
    );

    let builder_state = crate::dispatch::load_previous_provider_conversation_state(
        &transaction,
        &conversation_id,
        Some("openai"),
        Some(&agent_b_id),
        Some("builder"),
    )
    .await
    .expect("load builder conversation state");
    assert_eq!(
        builder_state
            .as_ref()
            .and_then(|value| value.get("responseId"))
            .and_then(serde_json::Value::as_str),
        Some("resp_agent_b")
    );

    transaction.rollback().await?;
    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn agent_context_cards_round_trip_scoped_by_agent_and_conversation() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping agent context card test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let user_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    ensure_agent_context_cards_test_table(&pool).await?;
    ensure_test_user(&pool, &user_id).await?;
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into projects (id, owner_user_id, project_type, status)
             values ($1, $2, 'customer', 'active')",
            &[&project_id, &user_id],
        )
        .await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    let state = build_test_state(pool.clone(), config.clone());
    let token =
        crate::auth::issue_controller_token(&config, &user_id).expect("mint controller user token");

    let app = crate::agent_contexts::router().with_state(state.clone());
    let payload = json!({
        "agent": "@octo",
        "scopeKind": "conversation",
        "scopeId": conversation_id.to_string(),
        "title": "Family note",
        "context": "The user said their uncle is named Tom.",
        "metadata": { "source": "test" }
    });

    let created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/agent-contexts"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::from(serde_json::to_vec(&payload)?))?,
        )
        .await?;
    let created_status = created.status();
    let created_body = to_bytes(created.into_body(), usize::MAX).await?;
    assert_eq!(
        created_status,
        StatusCode::OK,
        "create response body: {}",
        String::from_utf8_lossy(&created_body)
    );
    let created_json: serde_json::Value = serde_json::from_slice(&created_body)?;
    assert_eq!(created_json["agent"]["handle"], "octo");
    assert_eq!(created_json["scopeKind"], "conversation");
    assert_eq!(created_json["scopeId"], conversation_id.to_string());

    let listed = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/projects/{project_id}/agent-contexts?agent=@octo&scopeKind=conversation&scopeId={conversation_id}"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::empty())?,
        )
        .await?;
    let listed_status = listed.status();
    let listed_body = to_bytes(listed.into_body(), usize::MAX).await?;
    assert_eq!(
        listed_status,
        StatusCode::OK,
        "list response body: {}",
        String::from_utf8_lossy(&listed_body)
    );
    let listed_json: serde_json::Value = serde_json::from_slice(&listed_body)?;
    let cards = listed_json.as_array().expect("context card list");
    assert_eq!(cards.len(), 1);
    assert_eq!(
        cards[0]["context"],
        "The user said their uncle is named Tom."
    );

    let multi_term_listed = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/projects/{project_id}/agent-contexts?agent=@octo&scopeKind=conversation&scopeId={conversation_id}&q=uncle%20Tom"
                ))
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::empty())?,
        )
        .await?;
    let multi_term_status = multi_term_listed.status();
    let multi_term_body = to_bytes(multi_term_listed.into_body(), usize::MAX).await?;
    assert_eq!(
        multi_term_status,
        StatusCode::OK,
        "multi-term list response body: {}",
        String::from_utf8_lossy(&multi_term_body)
    );
    let multi_term_json: serde_json::Value = serde_json::from_slice(&multi_term_body)?;
    let multi_term_cards = multi_term_json.as_array().expect("context card list");
    assert_eq!(multi_term_cards.len(), 1);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &user_id).await?;
    Ok(())
}

#[tokio::test]
async fn agent_context_cards_prune_oldest_per_user_project_agent() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping agent context pruning test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let user_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_agent_context_cards_test_table(&pool).await?;
    ensure_test_user(&pool, &user_id).await?;
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into projects (id, owner_user_id, project_type, status)
             values ($1, $2, 'customer', 'active')",
            &[&project_id, &user_id],
        )
        .await?;

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-origin-key",
    );
    let state = build_test_state(pool.clone(), config.clone());
    let token =
        crate::auth::issue_controller_token(&config, &user_id).expect("mint controller user token");

    let app = crate::agent_contexts::router().with_state(state.clone());
    let seed_payload = json!({
        "agent": "@octo",
        "scopeKind": "conversation",
        "scopeId": Uuid::new_v4().to_string(),
        "title": "Seed",
        "context": "Seed context card."
    });

    let seeded = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/agent-contexts"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::from(serde_json::to_vec(&seed_payload)?))?,
        )
        .await?;
    let seeded_status = seeded.status();
    let seeded_body = to_bytes(seeded.into_body(), usize::MAX).await?;
    assert_eq!(
        seeded_status,
        StatusCode::OK,
        "seed response body: {}",
        String::from_utf8_lossy(&seeded_body)
    );
    let seeded_json: serde_json::Value = serde_json::from_slice(&seeded_body)?;
    let agent_id = Uuid::parse_str(
        seeded_json["agent"]["id"]
            .as_str()
            .expect("seeded agent id"),
    )?;

    let overflow_count = crate::agent_contexts::MAX_CONTEXT_CARDS_PER_AGENT_PROJECT + 5;
    connection
        .execute(
            "insert into agent_context_cards (
                id, user_id, project_id, agent_id, scope_kind, scope_id, title, context, metadata, created_at, updated_at
             )
             select gen_random_uuid(),
                    $1,
                    $2,
                    $3,
                    'conversation',
                    'old-' || series::text,
                    'Old card',
                    'Old context ' || series::text,
                    '{}'::jsonb,
                    now() - ((series + 10) * interval '1 second'),
                    now() - ((series + 10) * interval '1 second')
             from generate_series(0, ($4::int - 1)) as series",
            &[&user_id, &project_id, &agent_id, &(overflow_count as i32)],
        )
        .await?;

    let fresh_scope_id = Uuid::new_v4().to_string();
    let fresh_payload = json!({
        "agent": "@octo",
        "scopeKind": "conversation",
        "scopeId": fresh_scope_id,
        "title": "Fresh",
        "context": "Fresh context that should survive pruning."
    });

    let fresh = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/agent-contexts"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", token.token),
                )
                .body(Body::from(serde_json::to_vec(&fresh_payload)?))?,
        )
        .await?;
    let fresh_status = fresh.status();
    let fresh_body = to_bytes(fresh.into_body(), usize::MAX).await?;
    assert_eq!(
        fresh_status,
        StatusCode::OK,
        "fresh response body: {}",
        String::from_utf8_lossy(&fresh_body)
    );

    let count: i64 = connection
        .query_one(
            "select count(*)::bigint
             from agent_context_cards
             where user_id = $1 and project_id = $2 and agent_id = $3",
            &[&user_id, &project_id, &agent_id],
        )
        .await?
        .get(0);
    assert_eq!(
        count,
        crate::agent_contexts::MAX_CONTEXT_CARDS_PER_AGENT_PROJECT
    );

    let fresh_exists: bool = connection
        .query_one(
            "select exists(
                select 1
                from agent_context_cards
                where user_id = $1
                  and project_id = $2
                  and agent_id = $3
                  and scope_id = $4
             )",
            &[&user_id, &project_id, &agent_id, &fresh_scope_id],
        )
        .await?
        .get(0);
    assert!(fresh_exists, "fresh context card should not be pruned");

    let oldest_scope_id = format!("old-{}", overflow_count - 1);
    let oldest_exists: bool = connection
        .query_one(
            "select exists(
                select 1
                from agent_context_cards
                where user_id = $1
                  and project_id = $2
                  and agent_id = $3
                  and scope_id = $4
             )",
            &[&user_id, &project_id, &agent_id, &oldest_scope_id],
        )
        .await?
        .get(0);
    assert!(
        !oldest_exists,
        "oldest overflow context card should be pruned"
    );

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &user_id).await?;
    Ok(())
}

#[tokio::test]
async fn persist_run_runtime_alert_metadata_merges_alert_details() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping runtime alert metadata test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                project_id uuid not null,
                metadata jsonb
            );",
        )
        .await?;

    let project_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, project_id, metadata) VALUES ($1, $2, $3::jsonb)",
            &[
                &run_id,
                &project_id,
                &PgJson(json!({
                    "provider": {
                        "id": "openai"
                    },
                    "custom": true
                })),
            ],
        )
        .await?;

    crate::dispatch::persist_run_runtime_alert_metadata(
        &mut client,
        &project_id,
        &[run_id],
        &json!({
            "reason": "runtime_unavailable",
            "message": "No runtime is connected for this project.",
            "detail": "status=stopped",
            "clearedRuntimePreference": true
        }),
    )
    .await
    .expect("persist runtime alert metadata");

    let metadata: serde_json::Value = client
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;

    assert_eq!(metadata["provider"]["id"], json!("openai"));
    assert_eq!(metadata["custom"], json!(true));
    assert_eq!(
        metadata["runtimeAlert"]["reason"],
        json!("runtime_unavailable")
    );
    assert_eq!(metadata["runtimeAlert"]["detail"], json!("status=stopped"));
    assert_eq!(
        metadata["runtimeAlert"]["clearedRuntimePreference"],
        json!(true)
    );

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn persist_canceled_run_metadata_merges_summary_and_cancellation_details(
) -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping canceled run metadata test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                metadata jsonb
            );",
        )
        .await?;

    let run_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, metadata) VALUES ($1, $2::jsonb)",
            &[
                &run_id,
                &PgJson(json!({
                    "provider": {
                        "id": "openai"
                    },
                    "custom": true
                })),
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    crate::conversations::persist_canceled_run_metadata(
        &transaction,
        &[run_id],
        "Canceled by user",
    )
    .await
    .expect("persist canceled run metadata");
    transaction.commit().await?;

    let metadata: serde_json::Value = client
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;

    assert_eq!(metadata["provider"]["id"], json!("openai"));
    assert_eq!(metadata["custom"], json!(true));
    assert_eq!(metadata["summary"], json!("Canceled by user"));
    assert_eq!(metadata["cancellation"]["outcome"], json!("canceled"));
    assert_eq!(metadata["cancellation"]["finalStatus"], json!("canceled"));
    assert_eq!(metadata["cancellation"]["runStatus"], json!("canceled"));
    assert_eq!(
        metadata["cancellation"]["summary"],
        json!("Canceled by user")
    );
    assert!(metadata["cancellation"]["errorMessage"].is_null());
    assert!(metadata["cancellation"]["artifactsCount"].is_null());
    assert!(metadata["cancellation"]["provider"].is_null());
    assert!(metadata["cancellation"]["creditSnapshot"].is_null());

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn persist_prompt_and_run_ai_access_metadata_override_client_claims() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping prompt/run AI access audit test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                metadata jsonb
            );
            CREATE TEMP TABLE prompts (
                id uuid PRIMARY KEY,
                metadata jsonb
            );",
        )
        .await?;

    let run_id = Uuid::new_v4();
    let prompt_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, metadata) VALUES ($1, $2::jsonb)",
            &[
                &run_id,
                &PgJson(json!({
                    "custom": true,
                    "aiAccessMode": "managed",
                    "managedAiUsed": true
                })),
            ],
        )
        .await?;
    client
        .execute(
            "INSERT INTO prompts (id, metadata) VALUES ($1, $2::jsonb)",
            &[
                &prompt_id,
                &PgJson(json!({
                    "customPrompt": true,
                    "aiAccessMode": "managed",
                    "managedAiUsed": true
                })),
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    crate::dispatch::persist_prompt_ai_access_metadata(&transaction, &prompt_id, false, false)
        .await
        .expect("persist prompt AI access audit");
    crate::dispatch::persist_run_ai_access_metadata(&transaction, &[run_id], false, false)
        .await
        .expect("persist run AI access audit");
    transaction.commit().await?;

    let metadata: serde_json::Value = client
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;

    assert_eq!(metadata["custom"], json!(true));
    assert_eq!(metadata["aiAccessMode"], json!("byoc"));
    assert_eq!(metadata["managedAiUsed"], json!(false));

    let prompt_metadata: serde_json::Value = client
        .query_one("SELECT metadata FROM prompts WHERE id = $1", &[&prompt_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;

    assert_eq!(prompt_metadata["customPrompt"], json!(true));
    assert_eq!(prompt_metadata["aiAccessMode"], json!("byoc"));
    assert_eq!(prompt_metadata["managedAiUsed"], json!(false));

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn persist_run_job_identity_overrides_client_metadata_in_dispatch_transaction(
) -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping run job identity test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                project_id uuid NOT NULL,
                metadata jsonb
            );",
        )
        .await?;

    let run_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let client_claimed_job_id = Uuid::new_v4();
    let authoritative_job_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, project_id, metadata) VALUES ($1, $2, $3::jsonb)",
            &[
                &run_id,
                &project_id,
                &PgJson(json!({
                    "custom": true,
                    "jobId": client_claimed_job_id,
                })),
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    crate::dispatch::persist_run_job_identity(
        &transaction,
        &project_id,
        &run_id,
        &authoritative_job_id,
    )
    .await
    .expect("persist authoritative run job identity");

    let in_transaction_metadata: serde_json::Value = transaction
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;
    assert_eq!(in_transaction_metadata["custom"], json!(true));
    assert_eq!(
        in_transaction_metadata["jobId"],
        json!(authoritative_job_id.to_string())
    );
    transaction.commit().await?;

    let hydrated_metadata: serde_json::Value = client
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;
    assert_eq!(
        hydrated_metadata["jobId"],
        json!(authoritative_job_id.to_string())
    );

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn persist_run_managed_ai_credit_metadata_merges_trace_details() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping managed AI credit trace test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE runs (
                id uuid PRIMARY KEY,
                metadata jsonb
            );",
        )
        .await?;

    let run_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO runs (id, metadata) VALUES ($1, $2::jsonb)",
            &[
                &run_id,
                &PgJson(json!({
                    "custom": true,
                    "managedAiCredit": {
                        "promptId": "00000000-0000-0000-0000-000000000001",
                        "reserve": {
                            "ledgerId": "00000000-0000-0000-0000-000000000002"
                        }
                    }
                })),
            ],
        )
        .await?;

    let transaction = client.transaction().await?;
    crate::dispatch::persist_run_managed_ai_credit_metadata(
        &transaction,
        &[run_id],
        &json!({
            "adjustment": {
                "ledgerId": "00000000-0000-0000-0000-000000000003",
                "idempotencyKey": "managed-ai-adjustment:test"
            },
            "charge": {
                "reservedUnits": 1,
                "chargedUnits": 2,
                "adjustmentUnits": 1
            }
        }),
    )
    .await
    .expect("persist managed AI credit trace");
    transaction.commit().await?;

    let metadata: serde_json::Value = client
        .query_one("SELECT metadata FROM runs WHERE id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;

    assert_eq!(metadata["custom"], json!(true));
    assert_eq!(
        metadata["managedAiCredit"]["reserve"]["ledgerId"],
        json!("00000000-0000-0000-0000-000000000002")
    );
    assert_eq!(
        metadata["managedAiCredit"]["adjustment"]["ledgerId"],
        json!("00000000-0000-0000-0000-000000000003")
    );
    assert_eq!(
        metadata["managedAiCredit"]["charge"]["chargedUnits"],
        json!(2)
    );

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn record_controller_assistant_message_persists_runtime_alert_notice() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping controller assistant message test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE conversations (
                id uuid PRIMARY KEY,
                root_conversation_id uuid,
                updated_at timestamptz not null default now(),
                last_message_id uuid,
                last_message_at timestamptz,
                last_message_preview text
            );
            CREATE TEMP TABLE conversation_messages (
                id uuid PRIMARY KEY,
                conversation_id uuid not null,
                project_id uuid not null,
                session_id uuid,
                created_by uuid,
                prompt_id uuid,
                run_id uuid,
                role text not null,
                content text not null,
                metadata jsonb not null default '{}'::jsonb,
                created_at timestamptz not null default now()
            );",
        )
        .await?;

    let conversation_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let prompt_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO conversations (id, root_conversation_id) VALUES ($1, null)",
            &[&conversation_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let message = crate::conversations::record_controller_assistant_message(
        &transaction,
        &project_id,
        &conversation_id,
        None,
        Some(prompt_id),
        Some(run_id),
        "Runtime is starting...",
        &json!({
            "source": "controller",
            "kind": "runtime_alert",
            "details": {
                "reason": "runtime_not_ready"
            }
        }),
    )
    .await
    .expect("record controller assistant message");
    transaction.commit().await?;

    assert_eq!(message.role, "assistant");
    assert_eq!(message.run_id, Some(run_id));
    assert_eq!(message.metadata["kind"], json!("runtime_alert"));

    let row = client
        .query_one(
            "SELECT last_message_id, last_message_preview FROM conversations WHERE id = $1",
            &[&conversation_id],
        )
        .await?;
    let last_message_id: Option<Uuid> = row.get("last_message_id");
    let last_message_preview: Option<String> = row.get("last_message_preview");
    assert_eq!(last_message_id, Some(message.id));
    assert!(last_message_preview
        .as_deref()
        .unwrap_or_default()
        .contains("Runtime is starting"));

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn record_controller_assistant_message_preserves_inline_reference_content(
) -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping controller assistant inline reference test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    client
        .batch_execute(
            "CREATE TEMP TABLE conversations (
                id uuid PRIMARY KEY,
                root_conversation_id uuid,
                updated_at timestamptz not null default now(),
                last_message_id uuid,
                last_message_at timestamptz,
                last_message_preview text
            );
            CREATE TEMP TABLE conversation_messages (
                id uuid PRIMARY KEY,
                conversation_id uuid not null,
                project_id uuid not null,
                session_id uuid,
                created_by uuid,
                prompt_id uuid,
                run_id uuid,
                role text not null,
                content text not null,
                metadata jsonb not null default '{}'::jsonb,
                created_at timestamptz not null default now()
            );",
        )
        .await?;

    let conversation_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let referenced_conversation_id = Uuid::new_v4();
    let referenced_message_id = Uuid::new_v4();
    let content = format!(
        "Tracked in [[thread:{referenced_conversation_id}|@octo auth]]. See [[message:{referenced_conversation_id}/{referenced_message_id}|latest trace]]."
    );
    client
        .execute(
            "INSERT INTO conversations (id, root_conversation_id) VALUES ($1, null)",
            &[&conversation_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let message = crate::conversations::record_controller_assistant_message(
        &transaction,
        &project_id,
        &conversation_id,
        None,
        None,
        None,
        &content,
        &json!({
            "source": "agent"
        }),
    )
    .await
    .expect("record controller assistant message");
    transaction.commit().await?;

    assert_eq!(message.content, content);
    assert_eq!(message.metadata["source"], json!("agent"));

    let row = client
        .query_one(
            "SELECT content FROM conversation_messages WHERE id = $1",
            &[&message.id],
        )
        .await?;
    let persisted_content: String = row.get("content");
    assert_eq!(persisted_content, content);

    connection_handle.abort();
    Ok(())
}

#[tokio::test]
async fn build_interruption_notice_summarizes_canceled_runs() -> anyhow::Result<()> {
    let notice = crate::conversations::build_interruption_notice(
        "Canceled",
        &[Uuid::new_v4(), Uuid::new_v4()],
        &[Uuid::new_v4(), Uuid::new_v4()],
    );

    assert_eq!(notice.content, "Canceled 2 runs.");
    assert_eq!(notice.metadata["kind"], json!("run_cancellation"));
    assert_eq!(notice.metadata["details"]["runCount"], json!(2));
    assert_eq!(notice.metadata["details"]["jobCount"], json!(2));
    assert_eq!(notice.metadata["details"]["runStatus"], json!("canceled"));

    let custom = crate::conversations::build_interruption_notice(
        "Stopped by operator",
        &[Uuid::new_v4()],
        &[Uuid::new_v4()],
    );
    assert_eq!(custom.content, "Stopped by operator (1 run canceled.)");

    Ok(())
}

#[tokio::test]
async fn runtime_stop_respects_idle_timeout_requirement() -> anyhow::Result<()> {
    let Some((mut client, connection_handle)) = connect_test_db().await? else {
        eprintln!("skipping idle timeout test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    create_runtime_tables(&mut client).await?;

    let runtime_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();

    client
        .execute(
            "INSERT INTO runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
             VALUES ($1, $2, 'self-hosted', 'ready', 600, now())",
            &[&runtime_id, &project_id],
        )
        .await?;

    let transaction = client.transaction().await?;
    let runtime = runtime::fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(|error| controller_error("fetch runtime", error))?;
    let outcome = runtime::perform_runtime_stop(
        &transaction,
        &runtime,
        runtime::StopOptions {
            source: "test",
            reason: None,
            skip_if_active_jobs: false,
            require_idle_timeout: true,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await
    .map_err(|error| controller_error("perform runtime stop", error))?;
    assert!(!outcome.status_changed);
    assert_eq!(
        outcome.skip_reason.as_deref(),
        Some("runtime_recently_seen")
    );
    transaction.rollback().await?;

    connection_handle.abort();
    Ok(())
}

fn controller_error(context: &str, error: (StatusCode, axum::Json<ApiError>)) -> anyhow::Error {
    let (status, axum::Json(body)) = error;
    anyhow::anyhow!(
        "{context} failed with status {} and message {}",
        status.as_u16(),
        body.message
    )
}

#[tokio::test]
async fn provider_dispatch_authorizes_job_tokens_with_provider_call_scope() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping provider dispatch scope test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let owner_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_id).await?;

    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let other_project_id = Uuid::new_v4();
    let provider_id = "camera:phone_01";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Provider dispatch')",
                &[&org_id, &format!("provider-dispatch-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&org_id, &owner_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $3, $4, 'customer', 'active'),
                        ($2, $3, $4, 'customer', 'active')",
                &[&project_id, &other_project_id, &org_id, &owner_id],
            )
            .await?;
        connection
            .batch_execute(
                "create table if not exists project_integrations (
                    id uuid primary key,
                    project_id uuid not null,
                    provider text not null,
                    status text not null,
                    connection_type text not null,
                    credential_id uuid,
                    metadata jsonb not null default '{}'::jsonb,
                    required_scopes jsonb not null default '[]'::jsonb,
                    capabilities jsonb not null default '[]'::jsonb,
                    created_by uuid,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now(),
                    unique (project_id, provider)
                );",
            )
            .await?;
        connection
            .execute(
                "insert into project_integrations (id, project_id, provider, status, connection_type)
                 values ($1, $2, $3, 'attached', 'device')
                 on conflict (project_id, provider)
                 do update set status = 'attached'",
                &[&Uuid::new_v4(), &project_id, &provider_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "provider-dispatch-scope",
    );
    let mint = |scopes: Vec<&str>, token_project: Uuid| -> anyhow::Result<String> {
        Ok(mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: token_project.to_string(),
                subject: owner_id.to_string(),
                project_id: token_project.to_string(),
                origin_id: None,
                runtime_id: None,
                protocol: None,
                scopes: scopes.into_iter().map(str::to_string).collect(),
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|error| controller_error("mint scoped token", error))?
        .token)
    };
    // An explicitly scoped token reserved for a future bounded provider grant.
    // Ordinary job-token minting deliberately withholds provider.call.
    let job_token = mint(vec!["prompt.execute", "provider.call"], project_id)?;
    // A job token that predates (or was stripped of) provider.call.
    let scopeless_job_token = mint(vec!["prompt.execute", "fs.write"], project_id)?;
    // provider.call for a different project must not cross project boundaries.
    let cross_project_token = mint(vec!["prompt.execute", "provider.call"], other_project_id)?;
    let user_token = crate::auth::issue_controller_token(&config, &owner_id)
        .map_err(|error| controller_error("mint controller user token", error))?
        .token;

    let app = crate::provider_requests::router().with_state(build_test_state(pool.clone(), config));

    let tool_call_body = json!({
        "providerId": provider_id,
        "name": "camera.snapshot",
        "arguments": { "quality": "low" },
        "timeoutMs": 5000,
    });
    let dispatch_tool_call = |token: String, body: serde_json::Value| {
        let app = app.clone();
        let uri = format!("/projects/{project_id}/provider-tools/call");
        async move {
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body)?))?,
            )
            .await
            .map_err(|error| anyhow::anyhow!("dispatch request failed: {error}"))
        }
    };

    // A job token without provider.call keeps getting 403 even though the
    // subject user owns the project: scoped tokens are capabilities, not
    // memberships.
    let denied_missing_scope =
        dispatch_tool_call(scopeless_job_token, tool_call_body.clone()).await?;
    assert_eq!(denied_missing_scope.status(), StatusCode::FORBIDDEN);

    // provider.call scoped to another project is rejected by project match.
    let denied_cross_project =
        dispatch_tool_call(cross_project_token, tool_call_body.clone()).await?;
    assert_eq!(denied_cross_project.status(), StatusCode::FORBIDDEN);

    {
        let connection = pool.get().await?;
        let denied_rows: i64 = connection
            .query_one(
                "select count(*) from project_provider_requests where project_id = $1",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(
            denied_rows, 0,
            "denied dispatches must not enqueue provider requests"
        );
    }

    // Background "device" that completes the next pending request over SQL so
    // the dispatch long-poll resolves without standing up the device routes.
    let spawn_completer = |response: serde_json::Value| {
        let pool = pool.clone();
        tokio::spawn(async move {
            for _ in 0..200u32 {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                let Ok(connection) = pool.get().await else {
                    continue;
                };
                let Ok(updated) = connection
                    .query(
                        "update project_provider_requests
                            set status = 'completed',
                                response = $2::jsonb,
                                completed_at = now(),
                                updated_at = now()
                          where id = (
                                select id from project_provider_requests
                                 where project_id = $1 and status = 'pending'
                                 limit 1
                          )
                      returning id",
                        &[&project_id, &PgJson(&response)],
                    )
                    .await
                else {
                    continue;
                };
                if !updated.is_empty() {
                    return;
                }
            }
        })
    };

    // A job token carrying provider.call for the right project dispatches the
    // tool call end to end.
    let completer = spawn_completer(json!({ "ok": true, "result": "snapshot-42" }));
    let allowed_job_token = dispatch_tool_call(job_token.clone(), tool_call_body.clone()).await?;
    assert_eq!(allowed_job_token.status(), StatusCode::OK);
    let allowed_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(allowed_job_token.into_body(), usize::MAX).await?)?;
    assert_eq!(allowed_payload["ok"], json!(true));
    assert_eq!(allowed_payload["result"], json!("snapshot-42"));
    completer.await?;
    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "select status, requested_by, tool_name from project_provider_requests
                  where project_id = $1
                  order by created_at desc
                  limit 1",
                &[&project_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "completed");
        assert_eq!(row.get::<_, Option<Uuid>>("requested_by"), Some(owner_id));
        assert_eq!(
            row.get::<_, Option<String>>("tool_name").as_deref(),
            Some("camera.snapshot")
        );
    }

    // The resource-read dispatch route accepts the same job token.
    let completer = spawn_completer(json!({ "ok": true, "exists": true, "text": "hello" }));
    let resource_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/provider-resources/read"))
                .header("authorization", format!("Bearer {job_token}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&json!({
                    "providerId": provider_id,
                    "uri": "camera://front/latest",
                    "timeoutMs": 5000,
                }))?))?,
        )
        .await
        .map_err(|error| anyhow::anyhow!("resource dispatch failed: {error}"))?;
    assert_eq!(resource_response.status(), StatusCode::OK);
    let resource_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(resource_response.into_body(), usize::MAX).await?)?;
    assert_eq!(resource_payload["ok"], json!(true));
    assert_eq!(resource_payload["text"], json!("hello"));
    completer.await?;

    // User-session dispatch still works, and an unanswered request drains
    // through the pending -> expired path instead of hanging.
    let unanswered = dispatch_tool_call(user_token, tool_call_body).await?;
    assert_eq!(unanswered.status(), StatusCode::OK);
    let unanswered_payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(unanswered.into_body(), usize::MAX).await?)?;
    assert_eq!(unanswered_payload["ok"], json!(false));
    assert!(
        unanswered_payload["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Timed out"),
        "expected timeout error, got {unanswered_payload}"
    );
    {
        let connection = pool.get().await?;
        let row = connection
            .query_one(
                "select status from project_provider_requests
                  where project_id = $1
                  order by created_at desc
                  limit 1",
                &[&project_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "expired");
    }

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from project_provider_requests where project_id = $1",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "delete from project_integrations where project_id = $1",
                &[&project_id],
            )
            .await?;
    }
    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_origin_project(&pool, &other_project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_id).await?;
    Ok(())
}

mod billing_processor_tests {
    use super::*;
    use crate::billing::plans::BillingPlan;
    use crate::billing::processors::{
        self, CheckoutInput, ProcessorContext, ProcessorError, ProcessorKind,
    };
    use httpmock::prelude::*;
    use std::collections::HashMap;

    fn paid_plan() -> BillingPlan {
        BillingPlan {
            id: "pro".to_string(),
            name: "Pro".to_string(),
            currency: "USD".to_string(),
            monthly_price_cents: 1000,
            credit_limit: 250,
            max_active_tunnels: 10,
            max_active_hosted_runtimes: 20,
            active: true,
        }
    }

    fn test_context<'a>(
        config: &'a AppConfig,
        client: &'a reqwest::Client,
    ) -> ProcessorContext<'a> {
        ProcessorContext {
            config,
            http_client: client,
        }
    }

    #[test]
    fn parse_processor_handles_aliases() {
        assert_eq!(processors::parse_processor("dev"), Some(ProcessorKind::Dev));
        assert_eq!(
            processors::parse_processor("test"),
            Some(ProcessorKind::Dev)
        );
        assert_eq!(
            processors::parse_processor("stripe"),
            Some(ProcessorKind::Stripe)
        );
        assert!(processors::parse_processor("unknown").is_none());
    }

    #[tokio::test]
    async fn dev_processor_rejects_paid_plans() {
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "processor-test",
        );
        let http_client = reqwest::Client::new();
        let context = test_context(&config, &http_client);
        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let plan = paid_plan();

        let result = processors::create_checkout_session(
            context,
            ProcessorKind::Dev,
            CheckoutInput {
                plan: &plan,
                org_id: &org_id,
                project_id: &project_id,
                success_url: "https://instafy.dev/success",
                cancel_url: "https://instafy.dev/cancel",
                customer_id: None,
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(ProcessorError::NotImplemented(message))
                if message.contains("Paid plans require")
        ));
    }

    #[tokio::test]
    async fn stripe_processor_requires_price_mapping() {
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "processor-test",
        );
        config.stripe = Some(StripeConfig {
            secret_key: "sk_test_missing".to_string(),
            api_base_url: "https://api.stripe.test".to_string(),
            price_lookup: HashMap::new(),
            webhook_secret: None,
            portal_configuration_id: None,
            webhook_tolerance_seconds: 300,
            checkout_tos_consent: false,
        });

        let http_client = reqwest::Client::new();
        let context = test_context(&config, &http_client);
        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let plan = paid_plan();

        let result = processors::create_checkout_session(
            context,
            ProcessorKind::Stripe,
            CheckoutInput {
                plan: &plan,
                org_id: &org_id,
                project_id: &project_id,
                success_url: "https://instafy.dev/success",
                cancel_url: "https://instafy.dev/cancel",
                customer_id: None,
            },
        )
        .await;

        assert!(matches!(result, Err(ProcessorError::MissingConfig(_))));
    }

    #[tokio::test]
    async fn stripe_processor_creates_checkout_session() {
        let server = MockServer::start_async().await;
        let checkout_url = "https://stripe.test/session";
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/v1/checkout/sessions")
                    .header("authorization", "Bearer sk_test_live")
                    .body_contains("line_items%5B0%5D%5Bprice%5D=price_pro123")
                    .body_contains("metadata%5BplanId%5D=pro");
                then.status(200).json_body(json!({
                    "url": checkout_url,
                    "id": "cs_test_123",
                    "expires_at": 1_700_000_000i64
                }));
            })
            .await;

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "processor-test",
        );
        config.stripe = Some(StripeConfig {
            secret_key: "sk_test_live".to_string(),
            api_base_url: server.base_url(),
            price_lookup: HashMap::from([("pro".to_string(), "price_pro123".to_string())]),
            webhook_secret: None,
            portal_configuration_id: None,
            webhook_tolerance_seconds: 300,
            checkout_tos_consent: false,
        });

        let http_client = reqwest::Client::new();
        let context = test_context(&config, &http_client);
        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let plan = paid_plan();
        let session = processors::create_checkout_session(
            context,
            ProcessorKind::Stripe,
            CheckoutInput {
                plan: &plan,
                org_id: &org_id,
                project_id: &project_id,
                success_url: "https://instafy.dev/success",
                cancel_url: "https://instafy.dev/cancel",
                customer_id: None,
            },
        )
        .await
        .expect("stripe session");

        mock.assert_async().await;
        assert_eq!(session.processor, ProcessorKind::Stripe);
        assert_eq!(session.checkout_url, checkout_url);
        assert_eq!(session.reference.as_deref(), Some("cs_test_123"));
        assert_eq!(session.expires_at.as_deref(), Some("1700000000"));
    }

    #[tokio::test]
    async fn stripe_processor_creates_billing_portal_session() {
        let server = MockServer::start_async().await;
        let portal_url = "https://billing.stripe.test/session";
        let subscription_id = "sub_test_123";
        let customer_id = "cus_test_123";

        let subscription_mock = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path(format!("/v1/subscriptions/{subscription_id}"))
                    .header("authorization", "Bearer sk_test_live");
                then.status(200).json_body(json!({
                    "customer": customer_id
                }));
            })
            .await;

        let portal_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/v1/billing_portal/sessions")
                    .header("authorization", "Bearer sk_test_live")
                    .body_contains(format!("customer={customer_id}"))
                    .body_contains("return_url=https%3A%2F%2Finstafy.dev%2Fstudio");
                then.status(200).json_body(json!({
                    "url": portal_url
                }));
            })
            .await;

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "processor-test",
        );
        config.stripe = Some(StripeConfig {
            secret_key: "sk_test_live".to_string(),
            api_base_url: server.base_url(),
            price_lookup: HashMap::new(),
            webhook_secret: None,
            portal_configuration_id: None,
            webhook_tolerance_seconds: 300,
            checkout_tos_consent: false,
        });

        let http_client = reqwest::Client::new();
        let context = test_context(&config, &http_client);
        let url = processors::create_portal_session(
            context,
            ProcessorKind::Stripe,
            subscription_id,
            "https://instafy.dev/studio",
        )
        .await
        .expect("portal session");

        subscription_mock.assert_async().await;
        portal_mock.assert_async().await;
        assert_eq!(url, portal_url);
    }
}

mod config_env_tests {
    use super::*;

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn stripe_config_reads_price_ids_from_env() {
        let _secret = EnvVarGuard::set("STRIPE_SECRET_KEY", "sk_test_123");
        let _api = EnvVarGuard::set("STRIPE_API_BASE_URL", "https://api.stripe.test");
        let _mapping = EnvVarGuard::unset("STRIPE_PRICE_MAPPING");
        let _starter = EnvVarGuard::set("STRIPE_PRICE_ID_STARTER", "price_starter123");
        let _pro = EnvVarGuard::set("STRIPE_PRICE_ID_PRO", "price_pro123");
        let _scale = EnvVarGuard::set("STRIPE_PRICE_ID_SCALE", "price_scale123");

        let config = StripeConfig::from_env().expect("stripe config present");
        assert_eq!(
            config.price_lookup.get("pro"),
            Some(&"price_pro123".to_string())
        );
        assert_eq!(
            config.price_lookup.get("scale"),
            Some(&"price_scale123".to_string())
        );
        assert_eq!(
            config.price_lookup.get("starter"),
            Some(&"price_starter123".to_string())
        );
    }
}

mod billing_service_tests {
    use super::*;
    use crate::billing::plans::BillingPlan;
    use crate::billing::processors::ProcessorKind;
    use crate::billing::service;

    fn starter_plan() -> BillingPlan {
        BillingPlan {
            id: "starter".to_string(),
            name: "Starter".to_string(),
            currency: "USD".to_string(),
            monthly_price_cents: 0,
            credit_limit: 25,
            max_active_tunnels: 3,
            max_active_hosted_runtimes: 5,
            active: true,
        }
    }

    fn pro_plan() -> BillingPlan {
        BillingPlan {
            id: "pro".to_string(),
            name: "Pro".to_string(),
            currency: "USD".to_string(),
            monthly_price_cents: 1000,
            credit_limit: 250,
            max_active_tunnels: 10,
            max_active_hosted_runtimes: 20,
            active: true,
        }
    }

    async fn prepare_billing_tables(client: &mut tokio_postgres::Client) -> anyhow::Result<()> {
        client
            .batch_execute(
                "CREATE TEMP TABLE org_subscriptions (
                    id uuid PRIMARY KEY,
                    org_id uuid NOT NULL,
                    processor text NOT NULL,
                    external_id text NOT NULL,
                    status text NOT NULL,
                    currency text NOT NULL,
                    credit_limit integer NOT NULL,
                    billing_cycle text NOT NULL,
                    updated_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE TEMP TABLE org_credit_balances (
                    org_id uuid PRIMARY KEY,
                    balance integer NOT NULL,
                    credit_limit integer NOT NULL,
                    updated_at timestamptz NOT NULL
                );",
            )
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn upsert_org_subscription_creates_and_updates() -> anyhow::Result<()> {
        let Some((mut client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping org subscription test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        prepare_billing_tables(&mut client).await?;
        let org_id = Uuid::new_v4();
        let starter_plan = starter_plan();
        let pro_plan = pro_plan();

        service::upsert_org_subscription(
            &client,
            &org_id,
            ProcessorKind::Dev,
            &starter_plan,
            None,
            None,
        )
        .await
        .expect("starter plan added");

        let starter_row = client
            .query_one(
                "SELECT processor, status, credit_limit, billing_cycle, external_id FROM org_subscriptions WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        let starter_processor: String = starter_row.get("processor");
        assert_eq!(starter_processor, "dev");
        let starter_status: String = starter_row.get("status");
        assert_eq!(starter_status, "active");
        let starter_limit: i32 = starter_row.get("credit_limit");
        assert_eq!(starter_limit, starter_plan.credit_limit);
        let starter_cycle: String = starter_row.get("billing_cycle");
        assert_eq!(starter_cycle, starter_plan.id);
        let starter_external: String = starter_row.get("external_id");
        assert!(!starter_external.trim().is_empty());

        service::upsert_org_subscription(
            &client,
            &org_id,
            ProcessorKind::Stripe,
            &pro_plan,
            None,
            Some("cs_test_123"),
        )
        .await
        .expect("upgrade plan applied");

        let upgraded_row = client
            .query_one(
                "SELECT processor, status, credit_limit, billing_cycle, external_id FROM org_subscriptions WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        assert_eq!(upgraded_row.get::<_, String>("processor"), "stripe");
        assert_eq!(upgraded_row.get::<_, String>("status"), "trialing");
        assert_eq!(
            upgraded_row.get::<_, i32>("credit_limit"),
            pro_plan.credit_limit
        );
        assert_eq!(upgraded_row.get::<_, String>("billing_cycle"), pro_plan.id);
        assert_eq!(upgraded_row.get::<_, String>("external_id"), "cs_test_123");

        service::upsert_org_subscription(
            &client,
            &org_id,
            ProcessorKind::Stripe,
            &pro_plan,
            Some("active"),
            Some("sub_456"),
        )
        .await
        .expect("webhook activation applied");

        let activated_row = client
            .query_one(
                "SELECT status, external_id FROM org_subscriptions WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        assert_eq!(activated_row.get::<_, String>("status"), "active");
        assert_eq!(activated_row.get::<_, String>("external_id"), "sub_456");

        connection_handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn sync_org_credit_limit_inserts_and_updates() -> anyhow::Result<()> {
        let Some((mut client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping credit balance test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        prepare_billing_tables(&mut client).await?;
        let org_id = Uuid::new_v4();

        service::sync_org_credit_limit(&client, &org_id, 50)
            .await
            .expect("balance inserted");
        let row = client
            .query_one(
                "SELECT balance, credit_limit FROM org_credit_balances WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        assert_eq!(row.get::<_, i32>("balance"), 50);
        assert_eq!(row.get::<_, i32>("credit_limit"), 50);

        service::sync_org_credit_limit(&client, &org_id, 80)
            .await
            .expect("balance updated");
        let updated = client
            .query_one(
                "SELECT balance, credit_limit FROM org_credit_balances WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        assert_eq!(updated.get::<_, i32>("balance"), 50);
        assert_eq!(updated.get::<_, i32>("credit_limit"), 80);

        service::sync_org_credit_limit(&client, &org_id, 20)
            .await
            .expect("balance clamped on downgrade");
        let clamped = client
            .query_one(
                "SELECT balance, credit_limit FROM org_credit_balances WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        assert_eq!(clamped.get::<_, i32>("balance"), 20);
        assert_eq!(clamped.get::<_, i32>("credit_limit"), 20);

        connection_handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn update_subscription_status_by_external_id_updates_matching_row() -> anyhow::Result<()>
    {
        let Some((mut client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping subscription status test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        prepare_billing_tables(&mut client).await?;
        let org_id = Uuid::new_v4();
        let pro_plan = pro_plan();

        service::upsert_org_subscription(
            &client,
            &org_id,
            ProcessorKind::Stripe,
            &pro_plan,
            Some("active"),
            Some("sub_test_123"),
        )
        .await
        .expect("subscription inserted");

        let update = service::update_subscription_status_by_external_id(
            &client,
            ProcessorKind::Stripe,
            "sub_test_123",
            "past_due",
        )
        .await
        .expect("status update succeeds");

        let service::StatusUpdateOutcome::Updated(update) = update else {
            panic!("expected matching subscription to be updated");
        };
        assert_eq!(update.org_id, org_id);
        assert_eq!(update.credit_limit, pro_plan.credit_limit);
        assert_eq!(update.previous_status, "active");

        let row = client
            .query_one(
                "SELECT status FROM org_subscriptions WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "past_due");

        let missing = service::update_subscription_status_by_external_id(
            &client,
            ProcessorKind::Stripe,
            "sub_missing",
            "active",
        )
        .await
        .expect("missing lookup does not fail");
        assert!(matches!(missing, service::StatusUpdateOutcome::NotFound));

        // A canceled subscription must never be resurrected by a stale or
        // replayed active/trialing status event.
        service::update_subscription_status_by_external_id(
            &client,
            ProcessorKind::Stripe,
            "sub_test_123",
            "canceled",
        )
        .await
        .expect("cancel succeeds");
        let resurrect = service::update_subscription_status_by_external_id(
            &client,
            ProcessorKind::Stripe,
            "sub_test_123",
            "active",
        )
        .await
        .expect("resurrect attempt does not fail");
        assert!(matches!(
            resurrect,
            service::StatusUpdateOutcome::SkippedCanceled { org_id: skipped } if skipped == org_id
        ));
        let row = client
            .query_one(
                "SELECT status FROM org_subscriptions WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "canceled");

        connection_handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn runtime_token_endpoint_mints_scoped_token() -> anyhow::Result<()> {
        let Some(pool) = setup_origin_test_pool().await? else {
            eprintln!("skipping runtime token test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        let project_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                    &[&project_id],
                )
                .await?;
        }

        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-origin-key",
        );

        let mut provider_configs = HashMap::new();
        provider_configs.insert(
            "default".to_string(),
            RuntimeProviderConfig {
                id: "default".to_string(),
                display_name: "Default".to_string(),
                kind: "noop".to_string(),
                owner_org_id: None,
                allowed_org_ids: vec![],
                endpoint: None,
                auth_token: None,
                metadata: None,
            },
        );
        let provider_registry =
            crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
        let http_client = reqwest::Client::new();
        let ota_registry = test_ota_registry(&config);
        let state = AppState {
            config: config.clone(),
            pool: pool.clone(),
            rate_limiter: RateLimiter::new(),
            connection_limiter: ConnectionLimiter::new(),
            events: crate::state::EventHub::new(),
            http_client,
            origin_proxy_client: reqwest::Client::new(),
            runtime_activity: crate::state::RuntimeActivityTracker::new(150),
            local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
            runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
            runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
            provider_registry,
            tunnel_broker: None,
            device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
            ota_registry,
            desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
            credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
        };

        let app = runtime::router().with_state(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/projects/{}/runtime/token",
                        project_id.to_string()
                    ))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        "Bearer service-role-token",
                    )
                    .body(Body::from(serde_json::to_vec(&json!({}))?))?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        let parsed: runtime::RuntimeTokenResponse = serde_json::from_slice(&body)?;
        let assigned_runtime_id = parsed
            .runtime_id
            .ok_or_else(|| anyhow::anyhow!("service runtime token omitted assigned runtimeId"))?;
        let claims =
            decode_scoped_token(&config, &parsed.token, "runtime token").expect("decode minted");
        let assigned_runtime_id = assigned_runtime_id.to_string();
        assert_eq!(
            claims.runtime_id.as_deref(),
            Some(assigned_runtime_id.as_str())
        );
        assert_eq!(claims.project_id, project_id.to_string());
        assert!(claims.scopes.iter().any(|scope| scope == "agent.lease"));
        assert!(claims.scopes.iter().any(|scope| scope == "origin.apply"));
        assert!(claims.scopes.iter().any(|scope| scope == "telemetry.write"));

        Ok(())
    }

    #[tokio::test]
    async fn runtime_register_requires_bearer_token() -> anyhow::Result<()> {
        let Some(pool) = setup_origin_test_pool().await? else {
            eprintln!("skipping runtime register test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        let project_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                    &[&project_id],
                )
                .await?;
        }

        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-origin-key",
        );

        let mut provider_configs = HashMap::new();
        provider_configs.insert(
            "default".to_string(),
            RuntimeProviderConfig {
                id: "default".to_string(),
                display_name: "Default".to_string(),
                kind: "noop".to_string(),
                owner_org_id: None,
                allowed_org_ids: vec![],
                endpoint: None,
                auth_token: None,
                metadata: None,
            },
        );
        let provider_registry =
            crate::state::ProviderRegistry::new(provider_configs, "default".to_string());
        let http_client = reqwest::Client::new();
        let ota_registry = test_ota_registry(&config);
        let state = AppState {
            config: config.clone(),
            pool: pool.clone(),
            rate_limiter: RateLimiter::new(),
            connection_limiter: ConnectionLimiter::new(),
            events: crate::state::EventHub::new(),
            http_client,
            origin_proxy_client: reqwest::Client::new(),
            runtime_activity: crate::state::RuntimeActivityTracker::new(150),
            local_workspaces: crate::state::LocalWorkspaceRegistry::new(),
            runtime_preferences: crate::state::RuntimePreferenceRegistry::new(),
            runtime_resource_usage: crate::state::RuntimeResourceUsageRegistry::new(),
            provider_registry,
            tunnel_broker: None,
            device_auth_sessions: crate::device_auth::DeviceAuthRegistry::new(),
            ota_registry,
            desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry::new_in_memory(),
            credential_refresh_locks: crate::state::CredentialRefreshLocks::new(),
        };

        let app = runtime::router().with_state(state.clone());
        let payload = json!({
            "projectId": project_id.to_string(),
            // This test exercises bearer-token enforcement for a user-owned
            // runtime. Provider-managed registration additionally requires a
            // controller service subject and is covered separately.
            "type": "self-hosted",
            "idleTtlSeconds": 120
        });

        // Missing auth should fail
        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/register")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&payload)?))?,
            )
            .await?;
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        // Bearer token with required scopes should succeed
        let scopes = vec![
            "agent.lease",
            "agent.heartbeat",
            "agent.message",
            "agent.complete",
            "agent.stop",
            "origin.register",
            "origin.presence",
            "origin.apply",
        ];
        let runtime_owner_id = Uuid::new_v4();
        let minted = mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: project_id.to_string(),
                subject: runtime_owner_id.to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: None,
                protocol: None,
                scopes: scopes.iter().map(|s| s.to_string()).collect(),
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .expect("mint scoped token");

        let authorized = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/register")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", minted.token),
                    )
                    .body(Body::from(serde_json::to_vec(&payload)?))?,
            )
            .await?;

        assert_eq!(authorized.status(), StatusCode::OK);
        let body = to_bytes(authorized.into_body(), usize::MAX).await?;
        let parsed: runtime::RuntimeRegisterResponse = serde_json::from_slice(&body)?;
        assert_eq!(parsed.agent_token.is_empty(), false);
        assert_eq!(parsed.lease_url.contains(&config.lease_path), true);

        Ok(())
    }

    #[tokio::test]
    async fn runtime_register_enforces_signed_runtime_and_lease_bindings() -> anyhow::Result<()> {
        let Some(pool) = setup_origin_test_pool().await? else {
            eprintln!("skipping runtime register binding test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let other_runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let other_lease_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into projects (id, project_type, status)
                     values ($1, 'customer', 'active')",
                    &[&project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                     values ($1, $3, 'default', 'requested', 120),
                            ($2, $3, 'default', 'requested', 120)",
                    &[&runtime_id, &other_runtime_id, &project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtime_leases (id, project_id, runtime_id, status, scope)
                     values ($1, $3, $4, 'launching', 'exclusive'),
                            ($2, $3, $5, 'launching', 'exclusive')",
                    &[
                        &lease_id,
                        &other_lease_id,
                        &project_id,
                        &runtime_id,
                        &other_runtime_id,
                    ],
                )
                .await?;
            connection
                .execute(
                    "update runtimes
                     set active_lease_id = case when id = $1 then $3::uuid else $4::uuid end
                     where id in ($1, $2)",
                    &[&runtime_id, &other_runtime_id, &lease_id, &other_lease_id],
                )
                .await?;
        }

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-origin-key",
        );
        let service_runtime_user_id = Uuid::new_v4();
        config.service_runtime_user_id = Some(service_runtime_user_id);
        let state = build_test_state(pool.clone(), config.clone());
        let app = runtime::router().with_state(state);
        let scopes = runtime::RUNTIME_TOKEN_REQUIRED_SCOPES
            .iter()
            .map(|scope| scope.to_string())
            .collect::<Vec<_>>();

        let matching_token = mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: service_runtime_user_id.to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes: scopes.clone(),
                lease_id: Some(lease_id.to_string()),
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .expect("mint matching runtime registration token");

        let cross_runtime = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/register")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", matching_token.token),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id,
                            "runtimeId": other_runtime_id,
                            "leaseId": lease_id,
                            "provider": "default"
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(cross_runtime.status(), StatusCode::UNAUTHORIZED);

        let cross_lease = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/register")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", matching_token.token),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id,
                            "runtimeId": runtime_id,
                            "leaseId": other_lease_id,
                            "provider": "default"
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(cross_lease.status(), StatusCode::UNAUTHORIZED);

        // Even a token whose body reproduces its signed fields cannot use a
        // lease that the database binds to another runtime.
        let mismatched_loaded_lease_token = mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: service_runtime_user_id.to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes,
                lease_id: Some(other_lease_id.to_string()),
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .expect("mint mismatched runtime registration token");
        let mismatched_loaded_lease = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/register")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", mismatched_loaded_lease_token.token),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id,
                            "runtimeId": runtime_id,
                            "leaseId": other_lease_id,
                            "provider": "default"
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(mismatched_loaded_lease.status(), StatusCode::UNAUTHORIZED);

        let matching = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/register")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", matching_token.token),
                    )
                    .body(Body::from(
                        json!({
                            "projectId": project_id,
                            "runtimeId": runtime_id,
                            "leaseId": lease_id,
                            "provider": "default"
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(matching.status(), StatusCode::OK);
        let response: runtime::RuntimeRegisterResponse =
            serde_json::from_slice(&to_bytes(matching.into_body(), usize::MAX).await?)?;
        assert_eq!(response.runtime_id, runtime_id);
        assert_eq!(response.lease_id, Some(lease_id));
        let renewed = decode_scoped_token(
            &config,
            response
                .runtime_token
                .as_deref()
                .expect("renewed runtime token"),
            "renewed runtime token",
        )
        .expect("decode renewed runtime token");
        assert_eq!(renewed.aud, runtime_id.to_string());
        assert_eq!(
            renewed.runtime_id.as_deref(),
            Some(runtime_id.to_string().as_str())
        );
        assert_eq!(
            renewed.lease_id.as_deref(),
            Some(lease_id.to_string().as_str())
        );

        Ok(())
    }

    #[tokio::test]
    async fn upsert_org_never_joins_foreign_org_on_slug_conflict() -> anyhow::Result<()> {
        let Some((mut client, _handle)) = connect_test_db().await? else {
            eprintln!("skipping upsert_org test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        client
            .batch_execute(
                "CREATE TEMP TABLE organizations (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    slug text NOT NULL UNIQUE,
                    name text NOT NULL
                );
                CREATE TEMP TABLE org_memberships (
                    org_id uuid NOT NULL,
                    user_id uuid NOT NULL,
                    role text NOT NULL,
                    invited_by uuid,
                    PRIMARY KEY (org_id, user_id)
                );",
            )
            .await?;

        let user_a = Uuid::new_v4();
        let user_b = Uuid::new_v4();

        let tx = client.transaction().await?;

        // First caller mints the org and becomes its owner.
        let first =
            crate::projects::upsert_org(&tx, "personal-team", "Personal team", Some(user_a))
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        let org_a = match first {
            crate::projects::OrgUpsertOutcome::Created(id, _) => id,
            other => anyhow::bail!("expected Created, got {other:?}"),
        };

        // A different user colliding on the same slug must NOT be attached
        // to the existing org (this was the shared personal-team leak).
        let second =
            crate::projects::upsert_org(&tx, "personal-team", "Personal team", Some(user_b))
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert!(
            matches!(second, crate::projects::OrgUpsertOutcome::SlugTakenByOthers),
            "foreign slug conflict must not resolve to the existing org"
        );
        let b_memberships: i64 = tx
            .query_one(
                "select count(*) from org_memberships where user_id = $1",
                &[&user_b],
            )
            .await?
            .get(0);
        assert_eq!(b_memberships, 0, "user_b must not gain any membership");

        // The name must also survive a foreign collision (no rename clobber).
        let name: String = tx
            .query_one("select name from organizations where id = $1", &[&org_a])
            .await?
            .get(0);
        assert_eq!(name, "Personal team");

        // The same user re-creating their slug stays idempotent.
        let again = crate::projects::upsert_org(&tx, "personal-team", "Renamed team", Some(user_a))
            .await
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        match again {
            crate::projects::OrgUpsertOutcome::Existing(id, _) => assert_eq!(id, org_a),
            other => anyhow::bail!("expected Existing for the owner, got {other:?}"),
        }

        // Service-role callers (no owner) keep idempotent-by-slug resolution.
        let service = crate::projects::upsert_org(&tx, "personal-team", "Personal team", None)
            .await
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        match service {
            crate::projects::OrgUpsertOutcome::Existing(id, _) => assert_eq!(id, org_a),
            other => anyhow::bail!("expected Existing for service role, got {other:?}"),
        }

        tx.rollback().await?;
        Ok(())
    }
}
