//! Instafy's browser on a space's own machine, on the migrated database:
//! registration consent and the stored `browserHost` capability, the
//! runtime status fields Studio reads, Shared dispatch while the hosted
//! browser policy changes, the policy-gated origin proxy routes, and the
//! profile store a covered space's machine uses to keep its sign-ins.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::config::{AppConfig, HostedBrowserHostPolicy, PgPool, RuntimeProviderConfig};
use crate::dispatch::{self, DispatchPromptRequest};
use crate::runtime::{RuntimeRegisterResponse, RUNTIME_TOKEN_REQUIRED_SCOPES};
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, spawn_aborting,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tokens::{decode_scoped_token, mint_scoped_token, ScopedTokenRequest};
use crate::AppState;

const HOSTED_PROVIDER: &str = "instafy-cloud";

/// The capabilities a lazy-host runtime reports at registration.
fn host_report() -> JsonValue {
    json!({
        "agent": true,
        "origin": true,
        "browserHost": { "version": 1, "modes": ["lazy"] },
    })
}

fn config(label: &str, policy: HostedBrowserHostPolicy) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: HOSTED_PROVIDER.to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    config.service_runtime_user_id = Some(Uuid::new_v4());
    config.hosted_browser_host = policy;
    // Only the hosted browser policy turns on the profile store here.
    config.browser_profile_persist_project_ids.clear();
    config.credential_keys = Some(
        crate::config::CredentialEncryptionKey::for_test("browser-host-profile-test-key").into(),
    );
    config
}

fn with_policy(config: &AppConfig, policy: HostedBrowserHostPolicy) -> AppConfig {
    let mut config = config.clone();
    config.hosted_browser_host = policy;
    config
}

/// A launching space machine whose lease the controller attested as a lazy
/// browser host (`attested` false leaves the attestation out).
async fn seed_space_machine(
    pool: &PgPool,
    project_id: &Uuid,
    attested: bool,
) -> anyhow::Result<(Uuid, Uuid)> {
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let mut metadata = json!({ "source": "studio" });
    if attested {
        metadata["_instafyManagedBrowserHost"] = json!({
            "version": 1,
            "mode": "lazy",
            "generation": lease_id.to_string(),
        });
    }
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into projects (id, project_type, status)
             values ($1, 'customer', 'active')
             on conflict (id) do nothing",
            &[project_id],
        )
        .await?;
    connection
        .execute(
            "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
             values ($1, $2, $3, 'requested', 600)",
            &[&runtime_id, project_id, &HOSTED_PROVIDER],
        )
        .await?;
    connection
        .execute(
            "insert into runtime_leases
                (id, project_id, runtime_id, status, scope, requested_at, metadata)
             values ($1, $2, $3, 'launching', 'exclusive', now(), $4)",
            &[&lease_id, project_id, &runtime_id, &PgJson(metadata)],
        )
        .await?;
    connection
        .execute(
            "update runtimes set active_lease_id = $2 where id = $1",
            &[&runtime_id, &lease_id],
        )
        .await?;
    Ok((runtime_id, lease_id))
}

/// Register the machine as the provider-launched runtime does: a controller
/// service token bound to the runtime and lease.
async fn register(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: &Uuid,
    capabilities: JsonValue,
) -> anyhow::Result<RuntimeRegisterResponse> {
    let config = &state.config;
    let token = mint_scoped_token(
        config,
        ScopedTokenRequest {
            audience: runtime_id.to_string(),
            subject: config
                .service_runtime_user_id
                .expect("service runtime user")
                .to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: RUNTIME_TOKEN_REQUIRED_SCOPES
                .iter()
                .map(|scope| scope.to_string())
                .collect(),
            lease_id: Some(lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
    .map_err(|(status, error)| anyhow::anyhow!("mint: {status} {}", error.0.message))?
    .token;
    let response = crate::runtime::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/register")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(
                    json!({
                        "projectId": project_id,
                        "runtimeId": runtime_id,
                        "leaseId": lease_id,
                        "provider": HOSTED_PROVIDER,
                        "capabilities": capabilities,
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    anyhow::ensure!(
        status == StatusCode::OK,
        "registration failed ({status}): {}",
        String::from_utf8_lossy(&bytes)
    );
    Ok(serde_json::from_slice(&bytes)?)
}

async fn stored_capabilities(pool: &PgPool, runtime_id: &Uuid) -> anyhow::Result<JsonValue> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select capabilities from runtimes where id = $1",
            &[runtime_id],
        )
        .await?
        .get::<_, PgJson<JsonValue>>("capabilities")
        .0)
}

async fn status_payload(state: &AppState, project_id: &Uuid) -> anyhow::Result<JsonValue> {
    let mut connection = state.pool.get().await?;
    let transaction = connection.transaction().await?;
    let status = crate::runtime::load_runtime_status_response(state, &transaction, project_id)
        .await
        .map_err(|(_, body)| anyhow::anyhow!(body.0.message.clone()))?;
    transaction.rollback().await?;
    Ok(serde_json::to_value(&status)?)
}

fn status_entry<'a>(payload: &'a JsonValue, runtime_id: &Uuid) -> &'a JsonValue {
    payload["runtimes"]
        .as_array()
        .and_then(|runtimes| {
            runtimes
                .iter()
                .find(|runtime| runtime["runtimeId"] == json!(runtime_id.to_string()))
        })
        .unwrap_or_else(|| panic!("runtime {runtime_id} missing from status: {payload}"))
}

#[tokio::test]
async fn registration_stores_browser_host_only_for_the_attested_live_generation(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("browser host registration test").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let config = config(
            "browser-host-registration",
            HostedBrowserHostPolicy::Projects(vec![project_id]),
        );
        let state = build_test_state(pool.clone(), config);

        // Attested lease, reported host: consent and the controller's value.
        let (host, host_lease) = seed_space_machine(&pool, &project_id, true).await?;
        let mut spoofed_report = host_report();
        spoofed_report["browser_host"] = json!({ "version": 1, "mode": "lazy" });
        register(&state, &project_id, &host, &host_lease, spoofed_report).await?;
        let capabilities = stored_capabilities(&pool, &host).await?;
        assert_eq!(
            capabilities["browserHost"],
            json!({ "version": 1, "mode": "lazy", "generation": host_lease.to_string() }),
            "{capabilities}"
        );
        assert!(capabilities.get("browser_host").is_none(), "{capabilities}");
        assert_eq!(
            capabilities["_instafySharedBrowserAgentConsent"],
            json!({ "version": 1 })
        );

        // Attested lease, no report: neither.
        let (silent, silent_lease) = seed_space_machine(&pool, &project_id, true).await?;
        register(
            &state,
            &project_id,
            &silent,
            &silent_lease,
            json!({ "agent": true, "origin": true }),
        )
        .await?;
        let capabilities = stored_capabilities(&pool, &silent).await?;
        assert!(capabilities.get("browserHost").is_none(), "{capabilities}");
        assert!(
            capabilities
                .get("_instafySharedBrowserAgentConsent")
                .is_none(),
            "{capabilities}"
        );

        // Reported host, no attestation: a spoofed value is stripped.
        let (unattested, unattested_lease) = seed_space_machine(&pool, &project_id, false).await?;
        let mut forged = host_report();
        forged["browserHost"]["generation"] = json!(unattested_lease.to_string());
        forged["_instafySharedBrowserAgentConsent"] = json!({ "version": 1 });
        register(&state, &project_id, &unattested, &unattested_lease, forged).await?;
        let capabilities = stored_capabilities(&pool, &unattested).await?;
        assert!(capabilities.get("browserHost").is_none(), "{capabilities}");
        assert!(
            capabilities
                .get("_instafySharedBrowserAgentConsent")
                .is_none(),
            "{capabilities}"
        );
        Ok(())
    })
    .await
}

/// Studio's status read: `sharedBrowserHost` only on a live, covered,
/// registered host; `sharedBrowserHostPolicy` on every response.
#[tokio::test]
async fn runtime_status_shows_a_registered_host_while_the_policy_covers_it() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("browser host status test").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let covered = config(
            "browser-host-status",
            HostedBrowserHostPolicy::Projects(vec![project_id]),
        );
        let state = build_test_state(pool.clone(), covered.clone());
        let (host, host_lease) = seed_space_machine(&pool, &project_id, true).await?;
        register(&state, &project_id, &host, &host_lease, host_report()).await?;

        // A private self-hosted machine carrying look-alike capabilities on a
        // live lease of its own.
        let private_runtime = Uuid::new_v4();
        let private_lease = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into runtimes (
                         id, project_id, provider, status, idle_ttl_seconds, last_seen_at,
                         capabilities
                     ) values ($1, $2, 'self-hosted', 'ready', 600, now(), $3)",
                    &[
                        &private_runtime,
                        &project_id,
                        &PgJson(json!({
                            "_instafySelfHostedAccess": {
                                "mode": "private",
                                "ownerUserId": Uuid::new_v4().to_string(),
                            },
                            "_instafySharedBrowserAgentConsent": { "version": 1 },
                            "browserHost": {
                                "version": 1,
                                "mode": "lazy",
                                "generation": private_lease.to_string(),
                            },
                        })),
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into runtime_leases (id, project_id, runtime_id, status, launched_at)
                     values ($1, $2, $3, 'active', now())",
                    &[&private_lease, &project_id, &private_runtime],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set active_lease_id = $2 where id = $1",
                    &[&private_runtime, &private_lease],
                )
                .await?;
        }

        let payload = status_payload(&state, &project_id).await?;
        assert_eq!(payload["sharedBrowserHostPolicy"], "covered", "{payload}");
        assert_eq!(
            status_entry(&payload, &host)["sharedBrowserHost"],
            json!({ "version": 1, "mode": "lazy" }),
            "{payload}"
        );
        assert!(
            status_entry(&payload, &private_runtime)
                .get("sharedBrowserHost")
                .is_none(),
            "{payload}"
        );
        // Nothing identifying the lease rides along.
        assert!(!payload.to_string().contains(&host_lease.to_string()));

        // Policy off: the field disappears at the next read.
        let off = build_test_state(
            pool.clone(),
            with_policy(&covered, HostedBrowserHostPolicy::Off),
        );
        let payload = status_payload(&off, &project_id).await?;
        assert_eq!(payload["sharedBrowserHostPolicy"], "off", "{payload}");
        assert!(status_entry(&payload, &host)
            .get("sharedBrowserHost")
            .is_none());

        // A stop's quarantine of the lease hides it as well.
        pool.get()
            .await?
            .execute(
                "update runtime_leases set status = 'cleanup_pending' where id = $1",
                &[&host_lease],
            )
            .await?;
        let payload = status_payload(&state, &project_id).await?;
        assert_eq!(payload["sharedBrowserHostPolicy"], "covered", "{payload}");
        assert!(status_entry(&payload, &host)
            .get("sharedBrowserHost")
            .is_none());
        Ok(())
    })
    .await
}

fn shared_dispatch_request(project_id: &Uuid, runtime_id: &Uuid) -> DispatchPromptRequest {
    DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Open the sign-in page.".to_string()),
        intent: Some("browser".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "browserTransport": "shared",
            "browserConsentVersion": 1,
            "browserRuntimeId": runtime_id,
            "browserPageId": "PAGE_target-1",
            "runtimeExpectations": {
                "workspaceFileChanges": false,
                "commandExecution": false,
                "browserExecution": true
            },
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
        conversation_id: Some(Uuid::new_v4().to_string()),
        runtime_id: Some(runtime_id.to_string()),
        runtime_display_name: None,
        prefer_runtime: Some(true),
    }
}

async fn machine_counts(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<(i64, i64, i64)> {
    let connection = pool.get().await?;
    let count = |sql: &'static str| {
        let connection = &connection;
        async move { Ok::<i64, anyhow::Error>(connection.query_one(sql, &[project_id]).await?.get(0)) }
    };
    Ok((
        count("select count(*) from runtimes where project_id = $1").await?,
        count("select count(*) from runtime_leases where project_id = $1").await?,
        count("select count(*) from agent_jobs where project_id = $1").await?,
    ))
}

/// Shared dispatch to the space's own machine follows the policy at once:
/// registration does not read the policy, so the stored consent outlives it
/// and the dispatch check is the immediate rollback.
#[tokio::test]
async fn shared_dispatch_to_a_browser_host_follows_the_policy() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("browser host dispatch test").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let covered = config(
            "browser-host-dispatch",
            HostedBrowserHostPolicy::Projects(vec![project_id]),
        );
        let state = build_test_state(pool.clone(), covered.clone());
        let context = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };

        let (host, host_lease) = seed_space_machine(&pool, &project_id, true).await?;
        register(&state, &project_id, &host, &host_lease, host_report()).await?;
        let (silent, silent_lease) = seed_space_machine(&pool, &project_id, true).await?;
        register(
            &state,
            &project_id,
            &silent,
            &silent_lease,
            json!({ "agent": true, "origin": true }),
        )
        .await?;

        // Without the report there is no consent.
        let before = machine_counts(&pool, &project_id).await?;
        let normalized = dispatch::normalize_dispatch_request(shared_dispatch_request(
            &project_id,
            &silent,
        ))
        .map_err(|(status, body)| anyhow::anyhow!("normalize: {status} {}", body.0.message))?;
        let (status, error) = dispatch::process_dispatch_prompt(&state, &context, normalized)
            .await
            .expect_err("a machine without the report has no consent");
        assert_eq!(status, StatusCode::CONFLICT, "{}", error.0.message);
        assert!(
            error.0.message.contains("predates action approvals"),
            "{}",
            error.0.message
        );
        assert_eq!(machine_counts(&pool, &project_id).await?, before);

        // Policy off for this space: refused, nothing sent.
        let off = build_test_state(
            pool.clone(),
            with_policy(
                &covered,
                HostedBrowserHostPolicy::Projects(vec![Uuid::new_v4()]),
            ),
        );
        let normalized =
            dispatch::normalize_dispatch_request(shared_dispatch_request(&project_id, &host))
                .map_err(|(status, body)| {
                    anyhow::anyhow!("normalize: {status} {}", body.0.message)
                })?;
        let (status, error) = dispatch::process_dispatch_prompt(&off, &context, normalized)
            .await
            .expect_err("the policy no longer covers the space");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            error.0.message,
            "Instafy's browser on this space's machine is turned off for this space; this request was not sent to another runtime."
        );
        assert_eq!(machine_counts(&pool, &project_id).await?, before);

        // Covered: the job goes to the host on its live lease, nothing new
        // is launched.
        let normalized =
            dispatch::normalize_dispatch_request(shared_dispatch_request(&project_id, &host))
                .map_err(|(status, body)| {
                    anyhow::anyhow!("normalize: {status} {}", body.0.message)
                })?;
        let response = dispatch::process_dispatch_prompt(&state, &context, normalized)
            .await
            .map_err(|(status, body)| anyhow::anyhow!("dispatch: {status} {}", body.0.message))?;
        let (runtimes, leases, jobs) = machine_counts(&pool, &project_id).await?;
        assert_eq!((runtimes, leases), (before.0, before.1));
        assert_eq!(jobs, before.2 + 1);
        let target: Option<Uuid> = pool
            .get()
            .await?
            .query_one(
                "select target_runtime_id from agent_jobs
                 where project_id = $1 and prompt_id = $2",
                &[&project_id, &response.prompt_id],
            )
            .await?
            .get(0);
        assert_eq!(target, Some(host));

        // A stored host value naming another generation is still gated.
        pool.get()
            .await?
            .execute(
                "update runtimes
                 set capabilities = jsonb_set(
                     capabilities, '{browserHost,generation}', to_jsonb($2::text))
                 where id = $1",
                &[&host, &Uuid::new_v4().to_string()],
            )
            .await?;
        let before = machine_counts(&pool, &project_id).await?;
        let normalized =
            dispatch::normalize_dispatch_request(shared_dispatch_request(&project_id, &host))
                .map_err(|(status, body)| {
                    anyhow::anyhow!("normalize: {status} {}", body.0.message)
                })?;
        let (status, error) = dispatch::process_dispatch_prompt(&off, &context, normalized)
            .await
            .expect_err("an earlier generation's host value is still gated");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            error.0.message,
            "Instafy's browser on this space's machine is turned off for this space; this request was not sent to another runtime."
        );
        assert_eq!(machine_counts(&pool, &project_id).await?, before);
        Ok(())
    })
    .await
}

/// A covered space keeps its sign-ins without the legacy allowlist: the
/// registered host's agent token carries the profile scope, and the store
/// answers the versioned protocol.
#[tokio::test]
async fn a_registered_host_on_a_covered_space_uses_the_profile_store() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("browser host profile test").await?;
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let config = config(
            "browser-host-profile",
            HostedBrowserHostPolicy::Projects(vec![project_id]),
        );
        assert!(config.browser_profile_persist_project_ids.is_empty());
        let state = build_test_state(pool.clone(), config.clone());
        let (host, host_lease) = seed_space_machine(&pool, &project_id, true).await?;
        let registered = register(&state, &project_id, &host, &host_lease, host_report()).await?;
        let claims = decode_scoped_token(&config, &registered.agent_token, "agent token")
            .map_err(|(status, body)| anyhow::anyhow!("decode: {status} {}", body.0.message))?;
        assert!(
            claims
                .scopes
                .iter()
                .any(|scope| scope == "agent.browser_profile"),
            "{:?}",
            claims.scopes
        );

        let app = crate::browser_profile::router().with_state(state);
        let empty = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/agent/browser-profile")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", registered.agent_token),
                    )
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(empty.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            empty.headers()["x-instafy-profile-write-policy"],
            "versioned-v2"
        );

        let saved = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/agent/browser-profile/v2?version=0")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", registered.agent_token),
                    )
                    .body(Body::from(&b"browser-host-profile"[..]))?,
            )
            .await?;
        let status = saved.status();
        let body: JsonValue =
            serde_json::from_slice(&to_bytes(saved.into_body(), usize::MAX).await?)?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["version"], 1, "{body}");
        Ok(())
    })
    .await
}

/// The two host routes reach the space's origin only while the policy covers
/// the space, with their scopes and the 4 KiB start body limit.
#[tokio::test]
async fn origin_proxy_browser_host_routes_follow_the_policy() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("browser host origin proxy test").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        pool.get()
            .await?
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        let calls = Arc::new(AtomicUsize::new(0));
        let gateway = axum::Router::new()
            .route(
                "/browser/host",
                axum::routing::get({
                    let calls = calls.clone();
                    move || {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            axum::Json(json!({ "version": 1, "state": "idle" }))
                        }
                    }
                }),
            )
            .route(
                "/browser/host/start",
                axum::routing::post({
                    let calls = calls.clone();
                    move |_body: axum::body::Bytes| {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            (
                                StatusCode::ACCEPTED,
                                axum::Json(json!({ "version": 1, "state": "starting" })),
                            )
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let _gateway = spawn_aborting(async move {
            axum::serve(listener, gateway)
                .await
                .expect("serve the stand-in gateway");
        });
        let mut covered = config(
            "browser-host-origin-proxy",
            HostedBrowserHostPolicy::Projects(vec![project_id]),
        );
        covered.hosted_origin_endpoint = Some(endpoint.clone());
        let origin_id = crate::origins::hosted_origin_id_for_project(&project_id);
        pool.get()
            .await?
            .execute(
                "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                 values ($1, $2, 'hosted', $3, array['http'])",
                &[&origin_id, &project_id, &endpoint],
            )
            .await?;
        let bearer = |scopes: &[&str]| {
            mint_scoped_token(
                &covered,
                ScopedTokenRequest {
                    audience: origin_id.to_string(),
                    subject: Uuid::new_v4().to_string(),
                    project_id: project_id.to_string(),
                    origin_id: Some(origin_id.to_string()),
                    runtime_id: None,
                    protocol: Some("http".to_string()),
                    scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
                    lease_id: None,
                    run_id: None,
                    prefer_runtime: None,
                    ttl_seconds: None,
                },
            )
            .map(|minted| minted.token)
            .map_err(|(status, body)| anyhow::anyhow!("mint: {status} {}", body.0.message))
        };
        let view = bearer(&["browser.view"])?;
        let control = bearer(&["browser.view", "browser.control"])?;
        let read = bearer(&["fs.read"])?;
        let send = |state: AppState, method: &str, path: &str, token: &str, body: Vec<u8>| {
            let request = Request::builder()
                .method(method)
                .uri(format!("/origin/{origin_id}/{path}"))
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(body));
            async move {
                let response = crate::origins::router()
                    .with_state(state)
                    .oneshot(request?)
                    .await?;
                let status = response.status();
                let bytes = to_bytes(response.into_body(), usize::MAX).await?;
                Ok::<_, anyhow::Error>((status, String::from_utf8_lossy(&bytes).to_string()))
            }
        };
        let start_body = br#"{"version":1}"#.to_vec();
        let state = build_test_state(pool.clone(), covered.clone());

        let (status, body) = send(state.clone(), "GET", "browser/host", &view, vec![]).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = send(
            state.clone(),
            "POST",
            "browser/host/start",
            &control,
            start_body.clone(),
        )
        .await?;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // Scopes: control starts, view and fs.read do not.
        let (status, _) = send(
            state.clone(),
            "POST",
            "browser/host/start",
            &view,
            start_body.clone(),
        )
        .await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = send(state.clone(), "GET", "browser/host", &read, vec![]).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // 4 KiB is the start body limit at the proxy.
        let mut at_limit = br#"{"version":1,"pad":""#.to_vec();
        at_limit.resize(4 * 1024 - 2, b'x');
        at_limit.extend_from_slice(br#""}"#);
        assert_eq!(at_limit.len(), 4 * 1024);
        let (status, body) = send(
            state.clone(),
            "POST",
            "browser/host/start",
            &control,
            at_limit.clone(),
        )
        .await?;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let mut over_limit = at_limit;
        over_limit.insert(1, b' ');
        let (status, body) = send(
            state.clone(),
            "POST",
            "browser/host/start",
            &control,
            over_limit,
        )
        .await?;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        // Policy off for the space: both routes are 404 and never forwarded.
        let off = build_test_state(
            pool.clone(),
            with_policy(&covered, HostedBrowserHostPolicy::Off),
        );
        let (status, body) = send(off.clone(), "GET", "browser/host", &view, vec![]).await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert!(body.contains("origin path not found"), "{body}");
        let (status, body) = send(
            off.clone(),
            "POST",
            "browser/host/start",
            &control,
            start_body.clone(),
        )
        .await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        // A token whose runtime is no longer authorized learns nothing about
        // the policy: it is refused the same way whether or not it covers
        // the space.
        let stale = mint_scoped_token(
            &covered,
            ScopedTokenRequest {
                audience: origin_id.to_string(),
                subject: Uuid::new_v4().to_string(),
                project_id: project_id.to_string(),
                origin_id: Some(origin_id.to_string()),
                runtime_id: Some(Uuid::new_v4().to_string()),
                protocol: Some("http".to_string()),
                scopes: vec!["browser.view".to_string(), "browser.control".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .map(|minted| minted.token)
        .map_err(|(status, body)| anyhow::anyhow!("mint: {status} {}", body.0.message))?;
        for state in [state.clone(), off] {
            let (status, body) = send(state.clone(), "GET", "browser/host", &stale, vec![]).await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
            let (status, body) = send(
                state,
                "POST",
                "browser/host/start",
                &stale,
                start_body.clone(),
            )
            .await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        Ok(())
    })
    .await
}

/// Managed TURN never mints a relay credential for a browser host's origin:
/// the host runs with WebRTC off and shares its machine with root model
/// shells. Another managed machine on a TURN-covered space still gets one.
#[tokio::test]
async fn origin_proxy_mints_no_relay_credential_for_a_browser_host() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("browser host relay credential test").await?;
    let host_project = Uuid::new_v4();
    let other_project = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![host_project, other_project],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let seen: Arc<std::sync::Mutex<Vec<(Option<String>, bool)>>> = Arc::default();
        let gateway = axum::Router::new().route(
            "/browser/capabilities",
            axum::routing::get({
                let seen = seen.clone();
                move |headers: axum::http::HeaderMap| {
                    let seen = seen.clone();
                    async move {
                        let policy = headers
                            .get("x-instafy-browser-webrtc-policy")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_string);
                        let ice = headers.contains_key("x-instafy-browser-webrtc-ice-servers");
                        seen.lock().expect("headers").push((policy, ice));
                        axum::Json(json!({ "webrtc": false }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let _gateway = spawn_aborting(async move {
            axum::serve(listener, gateway)
                .await
                .expect("serve the stand-in gateway");
        });

        let mut config = config(
            "browser-host-relay-credential",
            HostedBrowserHostPolicy::Projects(vec![host_project]),
        );
        config.hosted_origin_endpoint = Some(endpoint.clone());
        config.browser_turn_rest = Some(
            crate::browser_turn::BrowserTurnRestConfig::for_test_projects(
                "turns:turn.example.test:443",
                "0123456789abcdef0123456789abcdef",
                600,
                &format!("{host_project},{other_project}"),
            ),
        );
        let state = build_test_state(pool.clone(), config.clone());

        let mut origins = Vec::new();
        for (project_id, browser_host) in [(host_project, true), (other_project, false)] {
            let runtime_id = Uuid::new_v4();
            let lease_id = Uuid::new_v4();
            let mut capabilities = json!({
                "agent": true,
                "origin": true,
                "_instafySharedBrowserAgentConsent": { "version": 1 },
            });
            if browser_host {
                capabilities["browserHost"] = json!({
                    "version": 1,
                    "mode": "lazy",
                    "generation": lease_id.to_string(),
                });
            }
            let origin_id = crate::origins::hosted_origin_id_for_project(&project_id);
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
                    "insert into runtimes
                        (id, project_id, provider, status, idle_ttl_seconds, capabilities, last_seen_at)
                     values ($1, $2, $3, 'ready', 600, $4, now())",
                    &[&runtime_id, &project_id, &HOSTED_PROVIDER, &PgJson(capabilities)],
                )
                .await?;
            connection
                .execute(
                    "insert into runtime_leases
                        (id, project_id, runtime_id, status, scope, requested_at, metadata)
                     values ($1, $2, $3, 'active', 'exclusive', now(), '{}'::jsonb)",
                    &[&lease_id, &project_id, &runtime_id],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set active_lease_id = $2 where id = $1",
                    &[&runtime_id, &lease_id],
                )
                .await?;
            connection
                .execute(
                    "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                     values ($1, $2, 'hosted', $3, array['http'])",
                    &[&origin_id, &project_id, &endpoint],
                )
                .await?;
            connection
                .execute(
                    "insert into origin_instances
                        (project_id, runtime_id, lease_id, origin_id, mode, status, endpoint, protocols)
                     values ($1, $2, $3, $4, 'hosted', 'online', $5, array['http'])",
                    &[&project_id, &runtime_id, &lease_id, &origin_id, &endpoint],
                )
                .await?;
            let token = mint_scoped_token(
                &config,
                ScopedTokenRequest {
                    audience: origin_id.to_string(),
                    subject: Uuid::new_v4().to_string(),
                    project_id: project_id.to_string(),
                    origin_id: Some(origin_id.to_string()),
                    runtime_id: Some(runtime_id.to_string()),
                    protocol: Some("http".to_string()),
                    scopes: vec!["browser.view".to_string()],
                    lease_id: None,
                    run_id: None,
                    prefer_runtime: None,
                    ttl_seconds: None,
                },
            )
            .map(|minted| minted.token)
            .map_err(|(status, body)| anyhow::anyhow!("mint: {status} {}", body.0.message))?;
            origins.push((origin_id, token));
        }

        for (origin_id, token) in &origins {
            let response = crate::origins::router()
                .with_state(state.clone())
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri(format!("/origin/{origin_id}/browser/capabilities"))
                        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                        .body(Body::empty())?,
                )
                .await?;
            let status = response.status();
            let bytes = to_bytes(response.into_body(), usize::MAX).await?;
            assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&bytes));
        }

        let seen = seen.lock().expect("headers").clone();
        assert_eq!(
            seen,
            vec![
                (Some("disabled".to_string()), false),
                (Some("relay".to_string()), true),
            ]
        );
        Ok(())
    })
    .await
}
