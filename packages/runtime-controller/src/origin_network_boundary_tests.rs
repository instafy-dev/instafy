//! `SELF_HOSTED_ORIGIN_NETWORKS` at the controller's call sites: origin
//! registration, the project memory bootstrap and the relays, HTTP and
//! WebSocket (the GitHub import's status lookup is tested in `imports.rs`).
//! With only public addresses allowed, a private self-hosted runtime's origin
//! that is not at a public address gets nothing from the controller, and an
//! origin the controller does not hold to public addresses is still reached
//! without following a redirect. Each test needs `TEST_DATABASE_URL`
//! (`pnpm test:controller`).

use super::*;
use crate::config::SelfHostedOriginNetworks;
use crate::origin_network::test_support::{counting_listener, ScriptedLookup};

/// Part of the refusal every caller sees.
pub(crate) const NOT_PUBLIC: &str = "not at a public address";

/// The test configuration with `networks` and no hosted gateway.
fn config_with(networks: SelfHostedOriginNetworks, key_id: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    config.self_hosted_origin_networks = networks;
    config.hosted_origin_endpoint = None;
    config
}

/// A new active project, owned by `owner_user_id` when one is given.
pub(crate) async fn insert_project(
    pool: &PgPool,
    owner_user_id: Option<&Uuid>,
) -> anyhow::Result<Uuid> {
    let project_id = Uuid::new_v4();
    if let Some(owner_user_id) = owner_user_id {
        ensure_test_user(pool, owner_user_id).await?;
    }
    sql(
        pool,
        "insert into projects (id, owner_user_id, project_type, status)
         values ($1, $2, 'customer', 'active')",
        &[&project_id, &owner_user_id],
    )
    .await?;
    Ok(project_id)
}

/// A ready runtime of `provider` in `project_id`; with `owner_user_id`, one
/// that person attested as their private self-hosted runtime.
pub(crate) async fn insert_runtime(
    pool: &PgPool,
    project_id: &Uuid,
    provider: &str,
    owner_user_id: Option<&Uuid>,
) -> anyhow::Result<Uuid> {
    let runtime_id = Uuid::new_v4();
    let mut capabilities = json!({ "agent": true, "origin": true });
    if let Some(owner_user_id) = owner_user_id {
        crate::runtime::set_self_hosted_access_attestation(
            capabilities
                .as_object_mut()
                .expect("test capabilities are an object"),
            *owner_user_id,
        );
    }
    sql(
        pool,
        "insert into runtimes (
             id, project_id, provider, status, endpoint_url, task_ref,
             idle_ttl_seconds, last_seen_at, capabilities
         ) values (
             $1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), $5
         )",
        &[
            &runtime_id,
            project_id,
            &provider,
            &format!("origin-network-runtime-{runtime_id}"),
            &capabilities,
        ],
    )
    .await?;
    Ok(runtime_id)
}

/// `endpoint` as an online desktop origin of `project_id`, registered by
/// `runtime_id` when one is given.
pub(crate) async fn insert_origin(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: Option<&Uuid>,
    endpoint: &str,
) -> anyhow::Result<Uuid> {
    let origin_id = Uuid::new_v4();
    sql(
        pool,
        "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
         values ($1, $2, 'desktop', $3, ARRAY['http']::text[])",
        &[&origin_id, project_id, &endpoint],
    )
    .await?;
    if let Some(runtime_id) = runtime_id {
        let protocols = vec!["http".to_string()];
        sql(
            pool,
            "insert into origin_instances (
                 id, project_id, runtime_id, origin_id, required, mode, status,
                 endpoint, protocols, metadata
             ) values (
                 $1, $2, $3, $4, true, 'desktop', 'online',
                 $5, $6::text[], '{}'::jsonb
             )",
            &[
                &Uuid::new_v4(),
                project_id,
                runtime_id,
                &origin_id,
                &endpoint,
                &protocols,
            ],
        )
        .await?;
    }
    record_presence_heartbeat(
        pool,
        &origin_id,
        project_id,
        OriginPresenceStatus::Online,
        None,
        None,
        None,
    )
    .await?;
    Ok(origin_id)
}

/// A relay token for `subject` on `origin_id`.
fn origin_token(
    config: &AppConfig,
    project_id: &Uuid,
    origin_id: &Uuid,
    subject: &Uuid,
    scopes: &[&str],
) -> String {
    mint_scoped_token(
        config,
        ScopedTokenRequest {
            audience: origin_id.to_string(),
            subject: subject.to_string(),
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
    .expect("mint origin token")
    .token
}

/// The memory bootstrap of `project_id`, as `user_id`.
async fn bootstrap(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
) -> anyhow::Result<serde_json::Value> {
    let token = crate::auth::issue_controller_token(&state.config, user_id)
        .expect("issue user session token")
        .token;
    let response = crate::projects::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/memory/bootstrap"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX).await?,
    )?)
}

/// A private self-hosted runtime registers an endpoint only at a public
/// address, at its own loopback or at a tunnel this controller issued, unless
/// the operator allows private networks; a refused endpoint is not stored.
#[tokio::test]
async fn a_self_hosted_runtime_registers_no_endpoint_off_a_public_network() -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "a_self_hosted_runtime_registers_no_endpoint_off_a_public_network",
    )
    .await?;
    let owner_user_id = Uuid::new_v4();
    let lookup = ScriptedLookup::always("lan.test", &["10.0.0.5"])
        .and("localhost", &["127.0.0.1", "::1"])
        .and("origin.test", &["203.0.114.10"])
        // An issued tunnel keeps its address, so at the scheme's default port
        // this answer is never asked for.
        .and("k7m2qa.tunnels.example.com", &["10.0.0.7"]);
    let mut public = config_with(
        SelfHostedOriginNetworks::Public,
        "origin-network-registration",
    );
    public.previews.tunnel_domain = Some("tunnels.example.com".to_string());
    let mut private = public.clone();
    private.self_hosted_origin_networks = SelfHostedOriginNetworks::Private;

    let mut projects = Vec::new();
    for (config, endpoint, accepted) in [
        (&public, "http://10.0.0.5:54332", false),
        (&public, "http://lan.test:54332", false),
        (&public, "https://k7m2qa.tunnels.example.com:8443", false),
        (&public, "http://127.0.0.1:54332", true),
        (&public, "http://localhost:54332", true),
        (&public, "https://origin.test", true),
        (&public, "https://k7m2qa.tunnels.example.com", true),
        (&private, "http://10.0.0.5:54332", true),
    ] {
        let project_id = insert_project(&pool, Some(&owner_user_id)).await?;
        projects.push(project_id);
        let runtime_id =
            insert_runtime(&pool, &project_id, "self-hosted", Some(&owner_user_id)).await?;
        // A runtime registers its origin under its own id.
        let token = mint_scoped_token(
            config,
            ScopedTokenRequest {
                audience: project_id.to_string(),
                subject: owner_user_id.to_string(),
                project_id: project_id.to_string(),
                origin_id: Some(runtime_id.to_string()),
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes: vec!["origin.register".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .expect("mint origin registration token")
        .token;
        let mut state = build_test_state(pool.clone(), config.clone());
        state.public_origins = lookup.network();
        let response = crate::origins::router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/origin/register")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId": project_id.to_string(),
                            "originId": runtime_id.to_string(),
                            "mode": "desktop",
                            "endpoint": endpoint,
                            "protocols": ["http"],
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        let status = response.status();
        let body = String::from_utf8_lossy(&to_bytes(response.into_body(), usize::MAX).await?)
            .into_owned();
        let stored: i64 = sql_one(
            &pool,
            "select count(*) from workspace_origins where id = $1",
            &[&runtime_id],
        )
        .await?;
        if accepted {
            assert_eq!(status, StatusCode::OK, "{endpoint}: {body}");
            assert_eq!(stored, 1, "{endpoint}");
        } else {
            assert_eq!(status, StatusCode::FORBIDDEN, "{endpoint}: {body}");
            assert!(body.contains(NOT_PUBLIC), "{endpoint}: {body}");
            assert_eq!(stored, 0, "{endpoint}");
        }
    }

    for project_id in &projects {
        cleanup_origin_project(&pool, project_id).await?;
    }
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

/// The memory bootstrap sends nothing to a private self-hosted runtime's
/// origin that is not at a public address, whether its endpoint is the
/// address or a name that resolves to it, and answers `ok: false` with the
/// refusal as its reason. With private networks allowed it reaches the origin.
#[tokio::test]
async fn the_memory_bootstrap_sends_nothing_to_a_held_origin_off_a_public_network(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "the_memory_bootstrap_sends_nothing_to_a_held_origin_off_a_public_network",
    )
    .await?;
    let origin_server = httpmock::MockServer::start_async().await;
    let anything = origin_server
        .mock_async(|_when, then| {
            then.status(404);
        })
        .await;
    let port = origin_server.port();
    let owner_user_id = Uuid::new_v4();
    let lookup = ScriptedLookup::always("localhost", &["127.0.0.1"]);

    let mut projects = Vec::new();
    for endpoint in [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ] {
        let project_id = insert_project(&pool, Some(&owner_user_id)).await?;
        projects.push(project_id);
        let runtime_id =
            insert_runtime(&pool, &project_id, "self-hosted", Some(&owner_user_id)).await?;
        insert_origin(&pool, &project_id, Some(&runtime_id), &endpoint).await?;
        let mut state = build_test_state(
            pool.clone(),
            config_with(SelfHostedOriginNetworks::Public, "origin-network-bootstrap"),
        );
        state.public_origins = lookup.network();
        let answer = bootstrap(&state, &project_id, &owner_user_id).await?;
        assert_eq!(answer["ok"], json!(false), "{endpoint}: {answer}");
        assert!(
            answer["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains(NOT_PUBLIC)),
            "{endpoint}: {answer}"
        );
    }
    assert_eq!(anything.hits_async().await, 0);

    let private = build_test_state(
        pool.clone(),
        config_with(
            SelfHostedOriginNetworks::Private,
            "origin-network-bootstrap",
        ),
    );
    bootstrap(&private, &projects[0], &owner_user_id).await?;
    assert!(anything.hits_async().await > 0);

    for project_id in &projects {
        cleanup_origin_project(&pool, project_id).await?;
    }
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

/// An origin the controller does not hold to public addresses, here the
/// configured hosted gateway, is reached without following a redirect: the
/// bootstrap's requests end at the gateway's own answer.
#[tokio::test]
async fn the_memory_bootstrap_follows_no_redirect_from_an_origin_that_is_not_held(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "the_memory_bootstrap_follows_no_redirect_from_an_origin_that_is_not_held",
    )
    .await?;
    let elsewhere = httpmock::MockServer::start_async().await;
    let landed = elsewhere
        .mock_async(|_when, then| {
            then.status(200).json_body(json!({}));
        })
        .await;
    let gateway = httpmock::MockServer::start_async().await;
    let redirected_read = gateway
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET);
            then.status(302)
                .header("location", elsewhere.url("/landed"));
        })
        .await;
    let redirected_write = gateway
        .mock_async(|when, then| {
            when.method(httpmock::Method::POST);
            then.status(307)
                .header("location", elsewhere.url("/landed"));
        })
        .await;

    let owner_user_id = Uuid::new_v4();
    let project_id = insert_project(&pool, Some(&owner_user_id)).await?;
    let mut config = config_with(
        SelfHostedOriginNetworks::Public,
        "origin-network-gateway-redirect",
    );
    config.hosted_origin_endpoint = Some(gateway.base_url());
    let answer = bootstrap(
        &build_test_state(pool.clone(), config),
        &project_id,
        &owner_user_id,
    )
    .await?;

    assert!(
        redirected_read.hits_async().await + redirected_write.hits_async().await > 0,
        "{answer}"
    );
    assert_eq!(landed.hits_async().await, 0, "{answer}");

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}

/// A relay to a name the controller holds to public addresses, here a tunnel
/// host at a port that is not the scheme's default on an origin no runtime
/// registered, looks the name up only to connect, once per new connection: an
/// answer with an address that is not public is refused there with `403`,
/// and a name that does not resolve fails the request with `502`. Nothing
/// reaches the origin.
#[tokio::test]
async fn a_relay_to_a_held_name_off_a_public_network_is_refused_at_the_connection(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "a_relay_to_a_held_name_off_a_public_network_is_refused_at_the_connection",
    )
    .await?;
    let (port, accepted) = counting_listener().await;
    let service_user_id = Uuid::new_v4();
    let project_id = insert_project(&pool, None).await?;
    let origin_id = insert_origin(
        &pool,
        &project_id,
        None,
        &format!("http://k7m2qa.tunnels.example.com:{port}"),
    )
    .await?;
    let mut config = config_with(SelfHostedOriginNetworks::Public, "origin-network-relay");
    config.previews.tunnel_domain = Some("tunnels.example.com".to_string());
    config.service_runtime_user_id = Some(service_user_id);
    let token = origin_token(
        &config,
        &project_id,
        &origin_id,
        &service_user_id,
        &["fs.read"],
    );

    for (case, lookup, expected_status, expected_message) in [
        (
            "a name that resolves to loopback",
            ScriptedLookup::always("k7m2qa.tunnels.example.com", &["127.0.0.1"]),
            StatusCode::FORBIDDEN,
            NOT_PUBLIC,
        ),
        (
            // The send's own failure: nothing looked the name up before it.
            "a name that does not resolve",
            std::sync::Arc::new(ScriptedLookup::default()),
            StatusCode::BAD_GATEWAY,
            "origin proxy request failed",
        ),
    ] {
        let mut state = build_test_state(pool.clone(), config.clone());
        state.public_origins = lookup.network();
        let response = crate::origins::router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/origin/{origin_id}/entries"))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())?,
            )
            .await?;
        let status = response.status();
        let body = String::from_utf8_lossy(&to_bytes(response.into_body(), usize::MAX).await?)
            .into_owned();
        assert_eq!(status, expected_status, "{case}: {body}");
        assert!(body.contains(expected_message), "{case}: {body}");
        assert_eq!(
            lookup.calls.load(Ordering::SeqCst),
            1,
            "{case}: looked up once, to connect"
        );
    }
    assert_eq!(accepted.load(Ordering::SeqCst), 0);

    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

/// A WebSocket relay checks a held name before the upgrade, so a refusal is a
/// `403` answer to the handshake and nothing connects to the origin.
#[tokio::test]
async fn a_websocket_relay_to_a_held_name_off_a_public_network_answers_403_before_the_upgrade(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "a_websocket_relay_to_a_held_name_off_a_public_network_answers_403_before_the_upgrade",
    )
    .await?;
    let (port, accepted) = counting_listener().await;
    let service_user_id = Uuid::new_v4();
    let project_id = insert_project(&pool, None).await?;
    let origin_id = insert_origin(
        &pool,
        &project_id,
        None,
        &format!("http://k7m2qa.tunnels.example.com:{port}"),
    )
    .await?;
    let mut config = config_with(SelfHostedOriginNetworks::Public, "origin-network-websocket");
    config.previews.tunnel_domain = Some("tunnels.example.com".to_string());
    config.service_runtime_user_id = Some(service_user_id);
    let token = origin_token(
        &config,
        &project_id,
        &origin_id,
        &service_user_id,
        &["browser.view"],
    );
    let mut state = build_test_state(pool.clone(), config);
    state.public_origins =
        ScriptedLookup::always("k7m2qa.tunnels.example.com", &["127.0.0.1"]).network();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let app = crate::origins::router().with_state(state);
    let server = spawn_aborting(async move {
        let _ = axum::serve(listener, app).await;
    });

    let refusal = tokio_tungstenite::connect_async(format!(
        "ws://{address}/origin/{origin_id}/browser/screencast?token={token}"
    ))
    .await
    .expect_err("refused before the upgrade");
    match refusal {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 403);
            let body = response
                .body()
                .as_deref()
                .map(String::from_utf8_lossy)
                .unwrap_or_default();
            assert!(body.contains(NOT_PUBLIC), "{body}");
        }
        other => panic!("expected a 403 answer to the handshake, got {other}"),
    }
    assert_eq!(accepted.load(Ordering::SeqCst), 0);

    drop(server);
    cleanup_origin_project(&pool, &project_id).await?;
    Ok(())
}

/// A private self-hosted runtime's origin on a non-public address is relayed
/// only when the operator allows private networks: by default its owner's own
/// token is refused before anything reaches the origin.
#[tokio::test]
async fn self_hosted_origin_relays_reach_non_public_addresses_only_when_allowed(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "self_hosted_origin_relays_reach_non_public_addresses_only_when_allowed",
    )
    .await?;

    let server = httpmock::MockServer::start_async().await;
    let entries = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET).path("/entries");
            then.status(200).json_body(json!({ "entries": [] }));
        })
        .await;
    let endpoint = server.base_url();

    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
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
                    &format!("origin-network-runtime-{runtime_id}"),
                    &capabilities,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                 values ($1, $2, 'desktop', $3, ARRAY['http']::text[])",
                &[&origin_id, &project_id, &endpoint],
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
                     $5, $6::text[], '{}'::jsonb
                 )",
                &[
                    &Uuid::new_v4(),
                    &project_id,
                    &runtime_id,
                    &origin_id,
                    &endpoint,
                    &protocols,
                ],
            )
            .await?;
    }

    let private_config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "self-hosted-origin-networks",
    );
    assert_eq!(
        private_config.self_hosted_origin_networks,
        crate::config::SelfHostedOriginNetworks::Private
    );
    let mut public_config = private_config.clone();
    public_config.self_hosted_origin_networks = crate::config::SelfHostedOriginNetworks::Public;

    let owner_token = crate::auth::issue_controller_token(&private_config, &owner_user_id)
        .expect("mint owner controller token")
        .token;
    let private_app =
        crate::origins::router().with_state(build_test_state(pool.clone(), private_config));
    let access_response = private_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/access_token")
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "projectId": project_id.to_string(),
                        "protocol": "http",
                        "scopes": ["fs.read"],
                        "originId": origin_id.to_string()
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    let access_status = access_response.status();
    let access_body = to_bytes(access_response.into_body(), usize::MAX).await?;
    assert_eq!(
        access_status,
        StatusCode::OK,
        "owner token response: {}",
        String::from_utf8_lossy(&access_body)
    );
    let access_payload: serde_json::Value = serde_json::from_slice(&access_body)?;
    let origin_token = access_payload["token"]
        .as_str()
        .expect("origin token present")
        .to_string();
    let entries_request = || {
        Request::builder()
            .method("GET")
            .uri(format!("/origin/{origin_id}/entries"))
            .header("authorization", format!("Bearer {origin_token}"))
            .body(Body::empty())
    };

    let public_app =
        crate::origins::router().with_state(build_test_state(pool.clone(), public_config));
    let refused = public_app.oneshot(entries_request()?).await?;
    let refused_status = refused.status();
    let refused_body = to_bytes(refused.into_body(), usize::MAX).await?;
    assert_eq!(
        refused_status,
        StatusCode::FORBIDDEN,
        "public-only relay: {}",
        String::from_utf8_lossy(&refused_body)
    );
    assert!(String::from_utf8_lossy(&refused_body).contains("not at a public address"));
    assert_eq!(entries.hits_async().await, 0);

    let relayed = private_app.oneshot(entries_request()?).await?;
    assert_eq!(relayed.status(), StatusCode::OK);
    assert_eq!(entries.hits_async().await, 1);

    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    Ok(())
}
