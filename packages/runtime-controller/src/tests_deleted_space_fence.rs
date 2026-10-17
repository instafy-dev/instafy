//! What a deleted space refuses outside the agent routes, on the migrated
//! database: registration and agent login, including one that raced the
//! delete, a fs.read workspace lease read, an origin token's reads through
//! the origin proxy, a runtime machine's tunnels, and the tunnel broker's
//! credit hook.

use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Json;
use serde_json::{json, Value as JsonValue};
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::projects::{ensure_project_not_deleted, space_deleted, SPACE_DELETED_CODE};
use crate::runtime::RUNTIME_TOKEN_REQUIRED_SCOPES;
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, spawn_aborting,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::AppState;

const HOSTED_PROVIDER: &str = "instafy-cloud";
const HOOK_SECRET: &str = "deleted-space-fence-hook";

fn config(key_id: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
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
    config
}

async fn seed_project(
    pool: &PgPool,
    project_id: &Uuid,
    org_id: Option<&Uuid>,
) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into projects (id, org_id, project_type, status)
             values ($1, $2, 'customer', 'active')",
            &[project_id, &org_id],
        )
        .await?;
    Ok(())
}

async fn mark_deleted(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update projects set status = 'deleted' where id = $1",
            &[project_id],
        )
        .await?;
    Ok(())
}

/// A ready hosted runtime of the space on an active lease.
async fn seed_machine(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<(Uuid, Uuid)> {
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at, capabilities
             ) values ($1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), '{}'::jsonb)",
            &[
                &runtime_id,
                project_id,
                &HOSTED_PROVIDER,
                &format!("deleted-space-fence-{runtime_id}"),
            ],
        )
        .await?;
    connection
        .execute(
            "insert into runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
             values ($1, $2, $3, 'active', now(), now())",
            &[&lease_id, project_id, &runtime_id],
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

fn mint(config: &AppConfig, request: ScopedTokenRequest) -> anyhow::Result<String> {
    Ok(mint_scoped_token(config, request)
        .map_err(|(status, error)| anyhow::anyhow!("mint a token: {status} {}", error.0.message))?
        .token)
}

/// The runtime token of the machine `runtime_id` on `lease_id`.
fn runtime_bearer(
    config: &AppConfig,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: &Uuid,
) -> anyhow::Result<String> {
    mint(
        config,
        ScopedTokenRequest {
            audience: runtime_id.to_string(),
            subject: "runtime.test".to_string(),
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
}

/// The token a self-hosted machine of `owner_id` registers with.
fn self_hosted_registration_bearer(
    config: &AppConfig,
    project_id: &Uuid,
    owner_id: &Uuid,
) -> anyhow::Result<String> {
    mint(
        config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: owner_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: None,
            scopes: RUNTIME_TOKEN_REQUIRED_SCOPES
                .iter()
                .map(|scope| scope.to_string())
                .collect(),
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
}

async fn send(
    router: axum::Router,
    method: &str,
    path: &str,
    bearer: &str,
    body: Option<JsonValue>,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let mut request = Request::builder().method(method).uri(path).header(
        axum::http::header::AUTHORIZATION,
        format!("Bearer {bearer}"),
    );
    let body = match body {
        Some(body) => {
            request = request.header(axum::http::header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = router.oneshot(request.body(body)?).await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let body = if bytes.is_empty() {
        JsonValue::Null
    } else {
        serde_json::from_slice(&bytes)?
    };
    Ok((status, body))
}

fn assert_space_deleted((status, body): &(StatusCode, JsonValue), call: &str) {
    assert_eq!(*status, StatusCode::GONE, "{call}: {body}");
    assert_eq!(body["code"], SPACE_DELETED_CODE, "{call}: {body}");
}

async fn runtime_count(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from runtimes where project_id = $1",
            &[project_id],
        )
        .await?
        .get(0))
}

/// Wait until a session is blocked behind the session `blocker_pid`.
async fn wait_until_blocked_behind(pool: &PgPool, blocker_pid: i32) -> anyhow::Result<()> {
    let observer = pool.get().await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let blocked: i64 = observer
                .query_one(
                    "select count(*) from pg_stat_activity
                     where $1 = any(pg_blocking_pids(pid))",
                    &[&blocker_pid],
                )
                .await?
                .get(0);
            if blocked > 0 {
                return anyhow::Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("nothing waited on the uncommitted delete"))?
}

#[test]
fn the_space_deleted_refusal_carries_its_own_code() {
    let (status, Json(error)) = space_deleted(StatusCode::GONE);
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(
        serde_json::to_value(&error).expect("serialize the refusal"),
        json!({ "message": "This space was deleted.", "code": "space_deleted" })
    );
}

/// With its share lock, the check makes a delete that comes later wait for
/// the caller, and reads the delete that came first once it commits. Without
/// it, it holds up nothing.
#[tokio::test]
async fn the_deleted_space_check_orders_itself_with_a_delete() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("the_deleted_space_check_orders_itself").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id, None).await?;
        let delete_sql = "update projects set status = 'deleted' where id = $1";

        // A plain read holds up no delete.
        let mut reader_connection = pool.get().await?;
        let reader = reader_connection.transaction().await?;
        ensure_project_not_deleted(&reader, &project_id, false, StatusCode::GONE)
            .await
            .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.0.message))?;
        let mut deleter_connection = pool.get().await?;
        let deleter = deleter_connection.transaction().await?;
        tokio::time::timeout(
            Duration::from_secs(2),
            deleter.execute(delete_sql, &[&project_id]),
        )
        .await
        .map_err(|_| anyhow::anyhow!("a plain read held up the delete"))??;
        deleter.rollback().await?;
        reader.rollback().await?;
        drop(reader_connection);

        // A share lock taken first: the delete waits for it.
        let mut holder_connection = pool.get().await?;
        let holder = holder_connection.transaction().await?;
        let holder_pid: i32 = holder
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        ensure_project_not_deleted(&holder, &project_id, true, StatusCode::GONE)
            .await
            .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.0.message))?;
        let delete_pool = pool.clone();
        let delete = tokio::spawn(async move {
            delete_pool
                .get()
                .await?
                .execute(delete_sql, &[&project_id])
                .await?;
            anyhow::Ok(())
        });
        wait_until_blocked_behind(&pool, holder_pid).await?;
        holder.commit().await?;
        drop(holder_connection);
        tokio::time::timeout(Duration::from_secs(5), delete).await???;

        // The delete first: the check waits for it, then reads it.
        pool.get()
            .await?
            .execute(
                "update projects set status = 'active' where id = $1",
                &[&project_id],
            )
            .await?;
        let deleter = deleter_connection.transaction().await?;
        let deleter_pid: i32 = deleter
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        deleter.execute(delete_sql, &[&project_id]).await?;
        let check_pool = pool.clone();
        let check = tokio::spawn(async move {
            let mut connection = check_pool.get().await?;
            let transaction = connection.transaction().await?;
            let checked =
                ensure_project_not_deleted(&transaction, &project_id, true, StatusCode::GONE).await;
            transaction.rollback().await?;
            anyhow::Ok(checked.err().map(|(status, error)| (status, error.0.code)))
        });
        wait_until_blocked_behind(&pool, deleter_pid).await?;
        deleter.commit().await?;
        let refused = tokio::time::timeout(Duration::from_secs(5), check).await???;
        assert_eq!(
            refused,
            Some((StatusCode::GONE, Some(SPACE_DELETED_CODE.to_string())))
        );
        Ok(())
    })
    .await
}

/// A machine cannot register to a deleted space, nor log in to one, even
/// when it read the space before the delete committed: the second read under
/// the runtime row lock waits for the delete and refuses, and no runtime row
/// is left behind.
#[tokio::test]
async fn registration_and_login_refuse_a_deleted_space_even_mid_race() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("registration_and_login_refuse_a_deleted_space").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id, None).await?;
        let owner_id = Uuid::new_v4();
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "deleted-space-registration",
        );
        config.service_runtime_user_id = Some(owner_id);
        let state = build_test_state(pool.clone(), config.clone());
        let register_bearer = self_hosted_registration_bearer(&config, &project_id, &owner_id)?;
        let register_body = json!({
            "projectId": project_id,
            "type": "self-hosted",
            "idleTtlSeconds": 120,
        });
        let login_body = json!({ "projectId": project_id, "runtimeType": "self-hosted" });
        let register = |state: AppState| {
            let bearer = register_bearer.clone();
            let body = register_body.clone();
            async move {
                send(
                    crate::runtime::router().with_state(state),
                    "POST",
                    "/runtime/register",
                    &bearer,
                    Some(body),
                )
                .await
            }
        };
        let login = |state: AppState| {
            let body = login_body.clone();
            async move {
                send(
                    crate::agent::router().with_state(state),
                    "POST",
                    "/agent/login",
                    "service-role-token",
                    Some(body),
                )
                .await
            }
        };

        // Each call commits the delete while the call waits on it.
        for call in ["register", "login"] {
            let mut deleter_connection = pool.get().await?;
            let deleter = deleter_connection.transaction().await?;
            let deleter_pid: i32 = deleter
                .query_one("select pg_backend_pid()", &[])
                .await?
                .get(0);
            deleter
                .execute(
                    "update projects set status = 'deleted' where id = $1",
                    &[&project_id],
                )
                .await?;
            let racing = tokio::spawn(match call {
                "register" => futures_util::future::Either::Left(register(state.clone())),
                _ => futures_util::future::Either::Right(login(state.clone())),
            });
            wait_until_blocked_behind(&pool, deleter_pid).await?;
            deleter.commit().await?;
            let refused = tokio::time::timeout(Duration::from_secs(5), racing).await???;
            assert_space_deleted(&refused, call);
            assert_eq!(runtime_count(&pool, &project_id).await?, 0, "{call}");
            pool.get()
                .await?
                .execute(
                    "update projects set status = 'active' where id = $1",
                    &[&project_id],
                )
                .await?;
        }

        // Deleted before the call: registration is gone at once, and login
        // keeps the not-found any deleted space gets.
        mark_deleted(&pool, &project_id).await?;
        let refused = register(state.clone()).await?;
        assert_space_deleted(&refused, "register after the delete");
        let (status, body) = login(state.clone()).await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(runtime_count(&pool, &project_id).await?, 0);
        Ok(())
    })
    .await
}

/// A fs.read token of a deleted space reads no workspace lease: it gets the
/// not-found of a missing space, as the read's own comment promised.
#[tokio::test]
async fn a_fs_read_token_reads_no_lease_of_a_deleted_space() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("a_fs_read_token_reads_no_lease_of_a_deleted_space").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id, None).await?;
        let config = config("deleted-space-fs-read");
        let state = build_test_state(pool.clone(), config.clone());
        let bearer = mint(
            &config,
            ScopedTokenRequest {
                audience: project_id.to_string(),
                subject: Uuid::new_v4().to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: None,
                protocol: None,
                scopes: vec!["fs.read".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )?;
        let path = format!("/projects/{project_id}/lease");
        let read = || {
            send(
                crate::origins::router().with_state(state.clone()),
                "GET",
                &path,
                &bearer,
                None,
            )
        };

        let (status, body) = read().await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        mark_deleted(&pool, &project_id).await?;
        let (status, body) = read().await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["message"], "project not found");
        Ok(())
    })
    .await
}

/// An origin token minted before the delete is still valid until it
/// expires, and a hosted gateway checks the token alone, so the controller's
/// origin proxy refuses the deleted space itself: the token reads the
/// space's files through its hosted gateway origin until the delete, and
/// gets the space's 404 after it, without the request reaching the gateway.
#[tokio::test]
async fn an_origin_token_reads_nothing_of_a_deleted_space() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("an_origin_token_reads_nothing_of_a_deleted_space").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id, None).await?;
        // A stand-in hosted gateway that serves every file and counts reads.
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gateway = axum::Router::new().fallback({
            let reads = reads.clone();
            move || {
                let reads = reads.clone();
                async move {
                    reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Json(json!({ "content": "# Notes" }))
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let _gateway = spawn_aborting(async move {
            axum::serve(listener, gateway)
                .await
                .expect("serve the stand-in gateway");
        });
        let mut config = config("deleted-space-origin-proxy");
        config.hosted_origin_endpoint = Some(endpoint.clone());
        let state = build_test_state(pool.clone(), config.clone());
        let origin_id = crate::origins::hosted_origin_id_for_project(&project_id);
        pool.get()
            .await?
            .execute(
                "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                 values ($1, $2, 'hosted', $3, array['http'])",
                &[&origin_id, &project_id, &endpoint],
            )
            .await?;
        let bearer = mint(
            &config,
            ScopedTokenRequest {
                audience: origin_id.to_string(),
                subject: Uuid::new_v4().to_string(),
                project_id: project_id.to_string(),
                origin_id: Some(origin_id.to_string()),
                runtime_id: None,
                protocol: Some("http".to_string()),
                scopes: vec!["fs.read".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )?;
        let path = format!("/origin/{origin_id}/files/NOTES.md");
        let read = || {
            send(
                crate::origins::router().with_state(state.clone()),
                "GET",
                &path,
                &bearer,
                None,
            )
        };

        let (status, body) = read().await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["content"], "# Notes");
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);

        mark_deleted(&pool, &project_id).await?;
        let (status, body) = read().await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["message"], "project not found");
        assert_eq!(
            reads.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the gateway was not asked"
        );
        Ok(())
    })
    .await
}

/// A machine of a deleted space can neither request a tunnel nor report one's
/// status, but may still take its own tunnel down.
#[tokio::test]
async fn a_deleted_space_machine_only_revokes_its_tunnels() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_deleted_space_machine_only_revokes_its_tunnels").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id, None).await?;
        let (runtime_id, lease_id) = seed_machine(&pool, &project_id).await?;
        let grant_id = Uuid::new_v4();
        let tunnel_id = format!("tunnel-{grant_id}");
        pool.get()
            .await?
            .execute(
                "insert into runtime_tunnel_grants
                    (id, project_id, runtime_id, runtime_lease_id, tunnel_id, hostname, url,
                     status, expires_at)
                 values ($1, $2, $3, $4, $5, 'grant.example.dev', 'https://grant.example.dev',
                         'active', now() + interval '10 minutes')",
                &[&grant_id, &project_id, &runtime_id, &lease_id, &tunnel_id],
            )
            .await?;
        let config = config("deleted-space-tunnels");
        let state = build_test_state(pool.clone(), config.clone());
        let bearer = runtime_bearer(&config, &project_id, &runtime_id, &lease_id)?;
        let tunnels = || crate::tunnels::router().with_state(state.clone());
        let request_body = json!({ "runtimeId": runtime_id, "runtimeLeaseId": lease_id });
        let request_path = format!("/projects/{project_id}/tunnels/request");
        let status_path = format!("/projects/{project_id}/tunnels/{tunnel_id}/status");
        let revoke_path = format!("/projects/{project_id}/tunnels/{tunnel_id}/revoke");

        // While the space lives, both pass the machine check: the request
        // reaches the missing broker, the status report is recorded.
        let (status, body) = send(
            tunnels(),
            "POST",
            &request_path,
            &bearer,
            Some(request_body.clone()),
        )
        .await?;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        let (status, body) = send(
            tunnels(),
            "POST",
            &status_path,
            &bearer,
            Some(json!({ "status": "active" })),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");

        mark_deleted(&pool, &project_id).await?;
        let refused = send(
            tunnels(),
            "POST",
            &request_path,
            &bearer,
            Some(request_body),
        )
        .await?;
        assert_space_deleted(&refused, "tunnel request");
        let refused = send(
            tunnels(),
            "POST",
            &status_path,
            &bearer,
            Some(json!({ "status": "active" })),
        )
        .await?;
        assert_space_deleted(&refused, "tunnel status");

        let (status, body) =
            send(tunnels(), "POST", &revoke_path, &bearer, Some(json!({}))).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "revoked");
        Ok(())
    })
    .await
}

/// The tunnel broker's credit hook refuses a deleted space before it burns
/// anything, while another space of the same organization still pays.
#[tokio::test]
async fn the_tunnel_credit_hook_refuses_a_deleted_space_unbilled() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("the_tunnel_credit_hook_refuses_a_deleted_space").await?;
    let org_id = Uuid::new_v4();
    let live_project_id = Uuid::new_v4();
    let deleted_project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![live_project_id, deleted_project_id],
    };
    with_shared_db_fixture(fixture, async {
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, 'tunnel hook')",
                    &[&org_id, &format!("tunnel-hook-{org_id}")],
                )
                .await?;
            connection
                .execute(
                    "insert into org_credit_balances (org_id, balance, credit_limit)
                     values ($1, 50, 0)
                     on conflict (org_id) do update
                       set balance = excluded.balance, credit_limit = excluded.credit_limit",
                    &[&org_id],
                )
                .await?;
        }
        seed_project(&pool, &live_project_id, Some(&org_id)).await?;
        seed_project(&pool, &deleted_project_id, Some(&org_id)).await?;
        mark_deleted(&pool, &deleted_project_id).await?;
        let mut config = config("deleted-space-tunnel-hook");
        config.tunnel_broker_hook_secret = Some(HOOK_SECRET.to_string());
        config.tunnel_credit_burn_amount = 1;
        let state = build_test_state(pool.clone(), config);
        let acl = |project_id: Uuid| {
            send(
                crate::tunnels::router().with_state(state.clone()),
                "POST",
                "/tunnel-broker/hooks/acl",
                HOOK_SECRET,
                Some(json!({
                    "intent": "request",
                    "project_id": project_id,
                    "org_id": org_id,
                    "idempotency_key": format!("tunnel-hook-{project_id}"),
                })),
            )
        };
        let tunnel_burns = |project_id: Uuid| {
            let pool = pool.clone();
            async move {
                anyhow::Ok(
                    pool.get()
                        .await?
                        .query_one(
                            "select count(*) from org_credit_ledger
                             where project_id = $1 and reason = 'tunnel_grant'",
                            &[&project_id],
                        )
                        .await?
                        .get::<_, i64>(0),
                )
            }
        };

        let (status, body) = acl(live_project_id).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["allowed"], true, "{body}");
        assert_eq!(tunnel_burns(live_project_id).await?, 1);

        let (status, body) = acl(deleted_project_id).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body,
            json!({ "allowed": false, "reason": SPACE_DELETED_CODE })
        );
        assert_eq!(tunnel_burns(deleted_project_id).await?, 0);
        Ok(())
    })
    .await
}
