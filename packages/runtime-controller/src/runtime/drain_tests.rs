//! Database-backed tests of the pool-retirement drain: a real controller
//! state on the shared test database, a stand-in node provider (census,
//! origin address, release) and a stand-in runtime origin that does what the
//! real one does with the controller's credential.

use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Json;
use serde_json::{json, Value as JsonValue};
use tower::ServiceExt as _;
use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, spawn_aborting, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, AbortingTask, SharedDbFixture,
};
use crate::tokens::decode_scoped_token;
use crate::AppState;

const PROVIDER_ID: &str = "drain_test_provider";

/// What the stand-in node holds, and what was released on it.
#[derive(Clone, Default)]
struct Node {
    census: Arc<Mutex<JsonValue>>,
    released: Arc<Mutex<Vec<JsonValue>>>,
}

/// What the stand-in origin saw when the controller called `/git/flush`.
#[derive(Debug, Clone)]
struct FlushSeen {
    bearer: String,
    body: JsonValue,
    git_write: StatusCode,
}

#[derive(Clone)]
struct OriginStub {
    state: Arc<Mutex<Option<AppState>>>,
    project_id: Uuid,
    flushes: Arc<Mutex<Vec<FlushSeen>>>,
}

/// What the stand-in origin answers a flush: one local ref it could not
/// push, and a working folder whose own save did not land.
fn flush_answer() -> JsonValue {
    json!({
        "unpushedRefs": 1,
        "unpushedRefNames": ["20261010T080000Z-unsaved-abc"],
        "recoveryRefs": [],
        "workingState": {
            "durable": false,
            "persistedAt": "2026-10-10T08:00:00Z",
            "error": "unreachable",
        },
    })
}

async fn send(
    state: &AppState,
    router: axum::Router<AppState>,
    request: Request<Body>,
) -> (StatusCode, JsonValue) {
    let response = router
        .with_state(state.clone())
        .oneshot(request)
        .await
        .expect("controller route");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("controller body");
    (
        status,
        serde_json::from_slice(&body).unwrap_or(JsonValue::Null),
    )
}

async fn handle_flush(
    State(stub): State<OriginStub>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Json<JsonValue> {
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let state = stub
        .state
        .lock()
        .unwrap()
        .clone()
        .expect("controller state");
    let (git_write, _) = send(
        &state,
        crate::origins::router(),
        Request::builder()
            .method("POST")
            .uri(format!("/projects/{}/git/access_token", stub.project_id))
            .header("authorization", format!("Bearer {bearer}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "scopes": ["git.read", "git.write"], "ttlSeconds": 60 }).to_string(),
            ))
            .expect("git token request"),
    )
    .await;
    stub.flushes.lock().unwrap().push(FlushSeen {
        bearer,
        body,
        git_write,
    });
    Json(flush_answer())
}

struct DrainFixture {
    pool: PgPool,
    state: AppState,
    owner_user_id: Uuid,
    project_id: Uuid,
    runtime_id: Uuid,
    origin_endpoint: String,
    node: Node,
    flushes: Arc<Mutex<Vec<FlushSeen>>>,
    _provider: AbortingTask<()>,
    _origin: AbortingTask<()>,
}

impl DrainFixture {
    /// A space owned by `owner_user_id` with one runtime row on the
    /// stand-in provider, stopped (no active generation).
    async fn new(pool: PgPool, project_id: Uuid, owner_user_id: Uuid) -> anyhow::Result<Self> {
        let node = Node::default();
        *node.census.lock().unwrap() = json!({ "supported": true, "containers": [] });
        let runtime_id = Uuid::new_v4();
        let flushes = Arc::new(Mutex::new(Vec::new()));
        let shared_state: Arc<Mutex<Option<AppState>>> = Arc::new(Mutex::new(None));

        let origin_app = axum::Router::new()
            .route("/git/flush", axum::routing::post(handle_flush))
            .with_state(OriginStub {
                state: shared_state.clone(),
                project_id,
                flushes: flushes.clone(),
            });
        let origin_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let origin_endpoint = format!("http://{}", origin_listener.local_addr()?);
        let origin = spawn_aborting(async move {
            axum::serve(origin_listener, origin_app)
                .await
                .expect("serve stand-in origin");
        });

        let provider_app = {
            let census = node.census.clone();
            let released = node.released.clone();
            let attested = origin_endpoint.clone();
            axum::Router::new()
                // The node's provider says where a runtime's origin is.
                .route(
                    "/runtime/origin",
                    axum::routing::post(move || {
                        let attested = attested.clone();
                        async move { Json(json!({ "endpoint": attested })) }
                    }),
                )
                .route(
                    "/runtime/census",
                    axum::routing::post(move || {
                        let census = census.clone();
                        async move { Json(census.lock().unwrap().clone()) }
                    }),
                )
                .route(
                    "/runtime/release",
                    axum::routing::post(move |Json(body): Json<JsonValue>| {
                        let released = released.clone();
                        async move {
                            released.lock().unwrap().push(body);
                            StatusCode::NO_CONTENT
                        }
                    }),
                )
        };
        let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let provider_address = provider_listener.local_addr()?;
        let provider = spawn_aborting(async move {
            axum::serve(provider_listener, provider_app)
                .await
                .expect("serve stand-in provider");
        });

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "runtime-drain",
        );
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: PROVIDER_ID.to_string(),
            display_name: "Stand-in node".to_string(),
            kind: "test".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some(format!("http://{provider_address}")),
            auth_token: None,
            metadata: None,
        }];
        let state = build_test_state(pool.clone(), config);
        *shared_state.lock().unwrap() = Some(state.clone());

        ensure_test_user(&pool, &owner_user_id).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status, owner_user_id)
                 values ($1, 'customer', 'active', $2)",
                &[&project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, $3, 'stopped', 600)",
                &[&runtime_id, &project_id, &PROVIDER_ID],
            )
            .await?;
        drop(connection);

        Ok(Self {
            pool,
            state,
            owner_user_id,
            project_id,
            runtime_id,
            origin_endpoint,
            node,
            flushes,
            _provider: provider,
            _origin: origin,
        })
    }

    /// Make the runtime live on the node: an active generation with an
    /// online hosted origin, and its container in the census.
    async fn start_live(&self) -> anyhow::Result<Uuid> {
        let lease = Uuid::new_v4();
        let instance = Uuid::new_v4();
        let connection = self.pool.get().await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at, launched_at)
                 values ($1, $2, $3, 'active', now(), now())",
                &[&lease, &self.project_id, &self.runtime_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes
                 set active_lease_id = $2, status = 'ready', last_seen_at = now(),
                     endpoint_url = 'http://runtime.test'
                 where id = $1",
                &[&self.runtime_id, &lease],
            )
            .await?;
        connection
            .execute(
                "insert into origin_instances
                    (id, project_id, runtime_id, lease_id, required, mode, status)
                 values ($1, $2, $3, $4, true, 'hosted', 'requested')",
                &[&instance, &self.project_id, &self.runtime_id, &lease],
            )
            .await?;
        drop(connection);
        register(
            self.pool.clone(),
            self.project_id,
            self.runtime_id,
            lease,
            instance,
            self.origin_endpoint.clone(),
        )
        .await;
        self.node.census.lock().unwrap()["containers"] = json!([{
            "composeProject": format!("instafy-runtime-{}-live", self.project_id.simple()),
            "projectId": self.project_id,
            "runtimeId": self.runtime_id,
            "leaseId": lease,
            "running": true,
        }]);
        Ok(lease)
    }

    fn set_census(&self, census: JsonValue) {
        *self.node.census.lock().unwrap() = census;
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Option<JsonValue>,
    ) -> (StatusCode, JsonValue) {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(bearer) = bearer {
            request = request.header("authorization", format!("Bearer {bearer}"));
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .expect("request");
        send(&self.state, super::super::router(), request).await
    }

    async fn runtime_row(&self) -> anyhow::Result<(String, Option<Uuid>)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, active_lease_id from runtimes where id = $1",
                &[&self.runtime_id],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    async fn events(&self, kind: &str) -> anyhow::Result<Vec<JsonValue>> {
        Ok(self
            .pool
            .get()
            .await?
            .query(
                "select data from runtime_events where runtime_id = $1 and kind = $2 order by id",
                &[&self.runtime_id, &kind],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect())
    }
}

/// What a runtime's origin does when it starts: register its origin
/// instance online, and the runtime ready.
async fn register(
    pool: PgPool,
    project: Uuid,
    runtime: Uuid,
    lease: Uuid,
    instance: Uuid,
    endpoint: String,
) {
    let connection = pool.get().await.expect("connection");
    connection
        .execute(
            "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
             values ($1, $2, 'hosted', $3, array['http']::text[])
             on conflict (id) do update set endpoint = excluded.endpoint",
            &[&instance, &project, &endpoint],
        )
        .await
        .expect("workspace origin");
    connection
        .execute(
            "update origin_instances
             set origin_id = id, endpoint = $2, protocols = array['http']::text[],
                 mode = 'hosted', status = 'online', updated_at = now()
             where id = $1",
            &[&instance, &endpoint],
        )
        .await
        .expect("origin online");
    connection
        .execute(
            "update runtime_leases set status = 'active', launched_at = now() where id = $1",
            &[&lease],
        )
        .await
        .expect("lease active");
    connection
        .execute(
            "update runtimes set status = 'ready', last_seen_at = now(),
                 endpoint_url = 'http://runtime.test'
             where id = $1 and active_lease_id = $2",
            &[&runtime, &lease],
        )
        .await
        .expect("runtime ready");
}

async fn delete_users(users: &[Uuid]) -> anyhow::Result<()> {
    let url = std::env::var("TEST_DATABASE_URL")?;
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await?;
    let driver = tokio::spawn(connection);
    client
        .execute("delete from auth.users where id = any($1)", &[&users])
        .await?;
    drop(client);
    let _ = driver.await;
    Ok(())
}

const SERVICE: Option<&str> = Some("internal");

/// Every drain route answers the service role and nobody else: no bearer is
/// a 401, a user (even the space owner) or a scoped token a 403. The
/// checkout rescue route is gone, for the service role too.
#[tokio::test]
async fn drain_routes_answer_only_the_service_role() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime drain auth test").await?;
    let project_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
        let user_token = crate::auth::issue_controller_token(&fx.state.config, &fx.owner_user_id)
            .map_err(|(_, body)| anyhow::anyhow!("{}", body.0.message))?
            .token;
        let agent_token = crate::auth::issue_agent_token(
            &fx.state.config,
            &fx.project_id,
            &fx.runtime_id,
            None,
            None,
        )
        .map_err(|(_, body)| anyhow::anyhow!("{}", body.0.message))?
        .token;
        let routes: [(&str, &str, Option<JsonValue>); 3] = [
            ("GET", "/operator/runtime-drain/census", None),
            ("POST", "/operator/runtime-drain/fence", Some(json!({ "fenced": true, "ttlSeconds": 60 }))),
            (
                "POST",
                "/operator/runtime-drain/stop",
                Some(json!({ "runtimeId": fx.runtime_id, "projectId": fx.project_id, "leaseId": Uuid::new_v4() })),
            ),
        ];
        for (method, uri, body) in routes {
            let (status, _) = fx.call(method, uri, None, body.clone()).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} without a bearer");
            for bearer in [&user_token, &agent_token] {
                let (status, _) = fx.call(method, uri, Some(bearer), body.clone()).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
            }
        }
        assert!(!fx.state.runtime_drain.is_fenced());
        assert!(fx.node.released.lock().unwrap().is_empty());
        let (status, census) = fx
            .call("GET", "/operator/runtime-drain/census", SERVICE, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{census}");
        let (status, _) = fx
            .call(
                "POST",
                "/operator/runtime-drain/flush-checkout",
                SERVICE,
                Some(json!({ "projectId": fx.project_id })),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// The census joins the node's containers with the database: the runtime's
/// active generation is `live`, any other container an `orphan`. Checkouts
/// are no part of it: an older provider's checkout list is ignored and never
/// makes the census incomplete; only a provider that cannot list its node,
/// does not answer or cut its container list does.
#[tokio::test]
async fn the_census_tells_live_runtimes_from_orphans_and_lists_no_checkouts() -> anyhow::Result<()>
{
    let pool = crate::tests::require_origin_test_pool("runtime drain census test").await?;
    let project_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
        let lease = fx.start_live().await?;
        let stale_lease = Uuid::new_v4();
        fx.set_census(json!({
            "supported": true,
            "truncated": false,
            "containers": [
                {
                    "composeProject": "instafy-runtime-live",
                    "projectId": fx.project_id,
                    "runtimeId": fx.runtime_id,
                    "leaseId": lease,
                    "running": true,
                },
                {
                    "composeProject": "instafy-runtime-stale",
                    "projectId": fx.project_id,
                    "runtimeId": fx.runtime_id,
                    "leaseId": stale_lease,
                    "running": false,
                },
                {
                    "composeProject": "instafy-runtime-crashed",
                    "projectId": Uuid::new_v4(),
                    "runtimeId": Uuid::new_v4(),
                    "leaseId": Uuid::new_v4(),
                    "running": false,
                },
            ],
            // What a provider from before this change still lists.
            "checkouts": [{
                "projectId": Uuid::new_v4(),
                "runtimePresent": false,
                "stoppedCleanly": false,
                "unpushedRefs": 1,
                "unpushedRefNames": ["20261003T101010Z-unsaved-abc"],
                "unreadable": null,
                "empty": false,
            }],
        }));
        let (status, census) = fx
            .call("GET", "/operator/runtime-drain/census", SERVICE, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{census}");
        assert_eq!(census["fenced"], false);
        assert_eq!(census["complete"], true, "{census}");
        assert!(census.get("checkouts").is_none(), "{census}");
        let runtimes = census["runtimes"].as_array().unwrap();
        assert_eq!(runtimes.len(), 3, "{census}");
        let class_of = |compose: &str| {
            runtimes
                .iter()
                .find(|runtime| runtime["composeProject"] == compose)
                .map(|runtime| runtime["class"].as_str().unwrap().to_string())
        };
        assert_eq!(class_of("instafy-runtime-live").as_deref(), Some("live"));
        assert_eq!(class_of("instafy-runtime-stale").as_deref(), Some("orphan"));
        assert_eq!(
            class_of("instafy-runtime-crashed").as_deref(),
            Some("orphan")
        );
        let live = runtimes
            .iter()
            .find(|runtime| runtime["class"] == "live")
            .unwrap();
        assert_eq!(live["dbActiveLeaseId"], json!(lease));
        assert_eq!(live["dbStatus"], "ready");

        for incomplete in [
            json!({ "supported": false }),
            json!({ "supported": true, "truncated": true, "containers": [] }),
        ] {
            fx.set_census(incomplete.clone());
            let (_, census) = fx
                .call("GET", "/operator/runtime-drain/census", SERVICE, None)
                .await;
            assert_eq!(census["complete"], false, "{incomplete}: {census}");
        }
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// A drain stop refuses any generation but the one it names, and otherwise
/// flushes under the owner's save-only permission (nobody holds a workspace
/// lease) with the working folder's own save, releases the runtime and
/// reports the flush: what is still only on the node and whether canonical
/// holds the folder. Fields a caller adds to the request are ignored, and
/// the answer carries no checkout.
#[tokio::test]
async fn a_drain_stop_flushes_the_named_generation_only() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime drain stop test").await?;
    let project_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
        let lease = fx.start_live().await?;

        let (status, wrong) = fx
            .call(
                "POST",
                "/operator/runtime-drain/stop",
                SERVICE,
                Some(json!({ "runtimeId": fx.runtime_id, "projectId": fx.project_id, "leaseId": Uuid::new_v4() })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{wrong}");
        assert_eq!(wrong["statusChanged"], false);
        assert_eq!(wrong["skipReason"], "runtime_lease_mismatch");
        assert_eq!(wrong["flush"]["status"], "skipped");
        assert!(fx.flushes.lock().unwrap().is_empty());
        assert!(fx.node.released.lock().unwrap().is_empty());
        assert_eq!(fx.runtime_row().await?, ("ready".to_string(), Some(lease)));

        let (status, stopped) = fx
            .call(
                "POST",
                "/operator/runtime-drain/stop",
                SERVICE,
                Some(json!({
                    "runtimeId": fx.runtime_id,
                    "projectId": fx.project_id,
                    "leaseId": lease,
                    "unknownField": "ignored",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{stopped}");
        assert_eq!(stopped["ok"], true, "{stopped}");
        assert_eq!(stopped["statusChanged"], true, "{stopped}");
        assert_eq!(
            stopped["flush"],
            json!({
                "status": "flushed",
                "unpushedRefs": 1,
                "unpushedRefNames": ["20261010T080000Z-unsaved-abc"],
                "workingState": {
                    "durable": false,
                    "persistedAt": "2026-10-10T08:00:00Z",
                    "error": "unreachable",
                },
            }),
            "{stopped}"
        );
        assert!(stopped.get("checkout").is_none(), "{stopped}");
        assert!(stopped.get("checkoutError").is_none(), "{stopped}");
        let flushes = fx.flushes.lock().unwrap().clone();
        assert_eq!(flushes.len(), 1, "{flushes:?}");
        assert_eq!(flushes[0].body["workingState"], true, "{flushes:?}");
        let claims = decode_scoped_token(&fx.state.config, &flushes[0].bearer, "save grant")
            .map_err(|(_, body)| anyhow::anyhow!("{}", body.0.message))?;
        assert_eq!(claims.scopes, vec!["workspace.flush".to_string()]);
        assert_eq!(claims.sub, fx.owner_user_id.to_string());
        assert_eq!(flushes[0].git_write, StatusCode::OK);
        let released = fx.node.released.lock().unwrap().clone();
        assert_eq!(released.len(), 1);
        assert_eq!(released[0]["lease_id"], json!(lease));
        assert_eq!(fx.runtime_row().await?.0, "stopped");
        let drained = fx.events("pool_retirement_drain").await?;
        assert_eq!(drained.len(), 2, "{drained:?}");
        assert_eq!(drained[1]["flushStatus"], "flushed");
        assert_eq!(drained[1]["unpushedRefs"], 1);
        assert_eq!(drained[1]["action"], "pool_retirement_drain");
        let flushed = fx.events("workspace_flush").await?;
        assert_eq!(flushed.last().unwrap()["durable"], false, "{flushed:?}");
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// The fence: this process starts no runtime and its own stop sweeps leave
/// runtimes alone, while the drain's stops still run; it lapses or lifts.
#[tokio::test]
async fn the_fence_stops_starts_and_sweeps_but_not_the_drain() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime drain fence test").await?;
    let project_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
        let lease = fx.start_live().await?;
        let (status, fenced) = fx
            .call(
                "POST",
                "/operator/runtime-drain/fence",
                SERVICE,
                Some(json!({ "fenced": true, "ttlSeconds": 600 })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{fenced}");
        assert_eq!(fenced["fenced"], true);
        assert!(fenced["expiresAt"].is_string());
        let (status, _) = fx
            .call(
                "POST",
                "/operator/runtime-drain/fence",
                SERVICE,
                Some(json!({ "fenced": true, "ttlSeconds": 7200 })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "a fence is at most an hour");

        // A sweep's stop leaves the runtime alone.
        let swept = super::super::stop::stop_runtime_safely(
            &fx.state,
            &fx.runtime_id,
            super::super::stop::StopOptions {
                source: "idle_reaper",
                reason: Some("idle_timeout".to_string()),
                skip_if_active_jobs: true,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert_eq!(swept.outcome.skip_reason.as_deref(), Some("controller_retiring"));
        assert!(fx.flushes.lock().unwrap().is_empty());
        assert!(fx.node.released.lock().unwrap().is_empty());
        assert_eq!(fx.runtime_row().await?.0, "ready");

        // No runtime starts, the space's other runtimes included.
        let other_runtime = Uuid::new_v4();
        fx.pool
            .get()
            .await?
            .execute(
                "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, $3, 'stopped', 600)",
                &[&other_runtime, &fx.project_id, &PROVIDER_ID],
            )
            .await?;
        let other = {
            let mut connection = fx.pool.get().await?;
            let transaction = connection.transaction().await?;
            let other =
                super::super::db::fetch_runtime_for_update(&transaction, &other_runtime)
                    .await
                    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
            transaction.rollback().await?;
            other
        };
        let refused = super::super::ensure::ensure_runtime_for_requeued_jobs(
            &fx.state,
            &other,
            "runtime_drain_fence_test",
        )
        .await
        .expect_err("a fenced controller starts nothing");
        assert_eq!(refused.0, StatusCode::SERVICE_UNAVAILABLE);
        let (_, Json(refusal)) = refused;
        assert_eq!(refusal.code.as_deref(), Some("controller_retiring"));
        assert_eq!(
            fx.pool
                .get()
                .await?
                .query_one(
                    "select count(*) from runtime_leases where runtime_id = $1",
                    &[&other_runtime],
                )
                .await?
                .get::<_, i64>(0),
            0,
            "no generation was requested"
        );

        // The drain's own stop runs.
        let (status, stopped) = fx
            .call(
                "POST",
                "/operator/runtime-drain/stop",
                SERVICE,
                Some(json!({ "runtimeId": fx.runtime_id, "projectId": fx.project_id, "leaseId": lease })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{stopped}");
        assert_eq!(stopped["statusChanged"], true, "{stopped}");

        let (_, census) = fx
            .call("GET", "/operator/runtime-drain/census", SERVICE, None)
            .await;
        assert_eq!(census["fenced"], true);
        let (_, lifted) = fx
            .call(
                "POST",
                "/operator/runtime-drain/fence",
                SERVICE,
                Some(json!({ "fenced": false })),
            )
            .await;
        assert_eq!(lifted["fenced"], false);
        assert!(!fx.state.runtime_drain.is_fenced());
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// No controller bills a generation an earlier drain woke only to flush a
/// checkout, from the moment its start was marked (before its lease
/// existed) to its stop; a start marker only covers launches within minutes
/// of it, and the space's other runtimes are billed as before. No controller
/// writes these marks any more: the exclusion stays while a mark younger
/// than the event retention may exist.
#[tokio::test]
async fn the_credit_sweep_never_bills_a_drain_wake() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime drain billing test").await?;
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let woken = (Uuid::new_v4(), Uuid::new_v4());
    let starting = (Uuid::new_v4(), Uuid::new_v4());
    let long_ago = (Uuid::new_v4(), Uuid::new_v4());
    let billed = (Uuid::new_v4(), Uuid::new_v4());
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id],
    };
    with_shared_db_fixture(fixture, async {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Drain billing test')",
                &[&org_id, &format!("drain-billing-{}", &org_id.to_string()[..8])],
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
                "insert into org_credit_balances (org_id, balance, credit_limit) values ($1, 1000, 0)
                 on conflict (org_id) do update set balance = 1000, credit_limit = 0",
                &[&org_id],
            )
            .await?;
        for (runtime, lease) in [woken, starting, long_ago, billed] {
            connection
                .execute(
                    "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                     values ($1, $2, 'instafy-cloud', 'ready', 600)",
                    &[&runtime, &project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtime_leases
                        (id, project_id, runtime_id, status, requested_at, launched_at)
                     values ($1, $2, $3, 'active', now(), now())",
                    &[&lease, &project_id, &runtime],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set active_lease_id = $2 where id = $1",
                    &[&runtime, &lease],
                )
                .await?;
        }
        connection
            .execute(
                "insert into runtime_events (runtime_id, project_id, kind, data)
                 values ($1, $2, 'pool_retirement_flush_wake', $3)",
                &[
                    &woken.0,
                    &project_id,
                    &json!({ "phase": "started", "runtimeLeaseId": woken.1 }),
                ],
            )
            .await?;
        // Marked a moment before its lease was requested: the launch is
        // still under way.
        connection
            .execute(
                "insert into runtime_events (runtime_id, project_id, kind, data, created_at)
                 values ($1, $2, 'pool_retirement_flush_wake', '{\"phase\":\"starting\"}',
                         now() - interval '5 seconds')",
                &[&starting.0, &project_id],
            )
            .await?;
        // A start marker from long ago covers no later launch.
        connection
            .execute(
                "insert into runtime_events (runtime_id, project_id, kind, data, created_at)
                 values ($1, $2, 'pool_retirement_flush_wake', '{\"phase\":\"starting\"}',
                         now() - interval '10 minutes')",
                &[&long_ago.0, &project_id],
            )
            .await?;
        drop(connection);

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "runtime-drain-billing",
        );
        config.hosted_runtime_credit_burn_amount = 1;
        config.hosted_runtime_credit_burn_interval_seconds = 300;
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
        super::super::sweep_hosted_runtime_credit_usage(&state).await?;

        let rows = pool
            .get()
            .await?
            .query(
                "select metadata ->> 'runtimeId' from org_credit_ledger
                 where org_id = $1 and reason = 'hosted_runtime'",
                &[&org_id],
            )
            .await?;
        let mut runtimes: Vec<String> = rows.iter().map(|row| row.get(0)).collect();
        runtimes.sort();
        let mut expected = vec![long_ago.0.to_string(), billed.0.to_string()];
        expected.sort();
        assert_eq!(runtimes, expected, "only ordinary launches are billed");
        Ok(())
    })
    .await
}
