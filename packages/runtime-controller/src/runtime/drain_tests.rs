//! Database-backed tests of the pool-retirement drain: a real controller
//! state on the shared test database, a stand-in node provider (census,
//! ensure, release) and a stand-in runtime origin that does what the real
//! one does with the controller's credential.

use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::IntoResponse as _;
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

/// What the stand-in node holds, and how it changes.
#[derive(Clone, Default)]
struct Node {
    census: Arc<Mutex<JsonValue>>,
    /// Answers for the next census calls, in order, before `census` is
    /// used again: a body, or `None` for a failed call.
    census_script: Arc<Mutex<Vec<Option<JsonValue>>>>,
    /// A woken runtime never registers its origin.
    never_registers: Arc<Mutex<bool>>,
    /// The census after each release, in order.
    after_release: Arc<Mutex<Vec<JsonValue>>>,
    released: Arc<Mutex<Vec<JsonValue>>>,
    ensured: Arc<Mutex<Vec<JsonValue>>>,
}

/// What the stand-in origin saw when the controller called `/git/flush`.
#[derive(Debug, Clone)]
struct FlushSeen {
    bearer: String,
    git_write: StatusCode,
    /// Jobs the woken runtime could lease while it flushed.
    leasable_jobs: Option<usize>,
}

#[derive(Clone)]
struct OriginStub {
    state: Arc<Mutex<Option<AppState>>>,
    project_id: Uuid,
    runtime_id: Uuid,
    flushes: Arc<Mutex<Vec<FlushSeen>>>,
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

async fn handle_flush(State(stub): State<OriginStub>, headers: HeaderMap) -> Json<JsonValue> {
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
    // The woken runtime asks for work while it flushes.
    let lease_id = {
        let connection = state.pool.get().await.expect("connection");
        connection
            .query_one(
                "select active_lease_id from runtimes where id = $1",
                &[&stub.runtime_id],
            )
            .await
            .expect("runtime")
            .get::<_, Option<Uuid>>(0)
    };
    let agent_token = crate::auth::issue_agent_token(
        &state.config,
        &stub.project_id,
        &stub.runtime_id,
        lease_id.as_ref(),
        None,
    )
    .expect("agent token")
    .token;
    let (lease_status, leased) = send(
        &state,
        crate::agent::router(),
        Request::builder()
            .method("POST")
            .uri("/agent/lease")
            .header("authorization", format!("Bearer {agent_token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "max": 1, "lease_seconds": 60, "runtime_id": stub.runtime_id }).to_string(),
            ))
            .expect("agent lease request"),
    )
    .await;
    let leasable_jobs =
        (lease_status == StatusCode::OK).then(|| leased["jobs"].as_array().map_or(0, Vec::len));
    stub.flushes.lock().unwrap().push(FlushSeen {
        bearer,
        git_write,
        leasable_jobs,
    });
    Json(json!({ "unpushedRefs": 0, "unpushedRefNames": [], "recoveryRefs": [] }))
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
        *node.census.lock().unwrap() =
            json!({ "supported": true, "containers": [], "checkouts": [] });
        let runtime_id = Uuid::new_v4();
        let flushes = Arc::new(Mutex::new(Vec::new()));
        let shared_state: Arc<Mutex<Option<AppState>>> = Arc::new(Mutex::new(None));

        let origin_app = axum::Router::new()
            .route("/git/flush", axum::routing::post(handle_flush))
            .with_state(OriginStub {
                state: shared_state.clone(),
                project_id,
                runtime_id,
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
            let census_script = node.census_script.clone();
            let never_registers = node.never_registers.clone();
            let after_release = node.after_release.clone();
            let released = node.released.clone();
            let ensured = node.ensured.clone();
            let pool = pool.clone();
            let endpoint = origin_endpoint.clone();
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
                        let census_script = census_script.clone();
                        async move {
                            let scripted = {
                                let mut script = census_script.lock().unwrap();
                                (!script.is_empty()).then(|| script.remove(0))
                            };
                            match scripted {
                                Some(Some(body)) => Json(body).into_response(),
                                Some(None) => StatusCode::BAD_GATEWAY.into_response(),
                                None => Json(census.lock().unwrap().clone()).into_response(),
                            }
                        }
                    }),
                )
                .route(
                    "/runtime/release",
                    axum::routing::post({
                        let census = node.census.clone();
                        move |Json(body): Json<JsonValue>| {
                            let released = released.clone();
                            let after_release = after_release.clone();
                            let census = census.clone();
                            async move {
                                released.lock().unwrap().push(body);
                                let mut after_release = after_release.lock().unwrap();
                                if !after_release.is_empty() {
                                    *census.lock().unwrap() = after_release.remove(0);
                                }
                                StatusCode::NO_CONTENT
                            }
                        }
                    }),
                )
                .route(
                    "/runtime/ensure",
                    axum::routing::post({
                        let census = node.census.clone();
                        move |Json(body): Json<JsonValue>| {
                            let ensured = ensured.clone();
                            let census = census.clone();
                            let pool = pool.clone();
                            let endpoint = endpoint.clone();
                            let never_registers = never_registers.clone();
                            async move {
                                ensured.lock().unwrap().push(body.clone());
                                let project: Uuid =
                                    serde_json::from_value(body["project_id"].clone()).unwrap();
                                let runtime: Uuid =
                                    serde_json::from_value(body["runtime_id"].clone()).unwrap();
                                let lease: Uuid =
                                    serde_json::from_value(body["lease_id"].clone()).unwrap();
                                let instance: Option<Uuid> =
                                    serde_json::from_value(body["origin_instance_id"].clone())
                                        .unwrap_or(None);
                                {
                                    let mut census = census.lock().unwrap();
                                    census["containers"] = json!([{
                                        "composeProject": format!("instafy-runtime-{}-x", project.simple()),
                                        "projectId": project,
                                        "runtimeId": runtime,
                                        "leaseId": lease,
                                        "running": true,
                                    }]);
                                    if let Some(checkouts) = census["checkouts"].as_array_mut() {
                                        for checkout in checkouts {
                                            checkout["runtimePresent"] = json!(true);
                                        }
                                    }
                                }
                                // The runtime boots and registers once the
                                // launch fence lets go of its rows.
                                if !*never_registers.lock().unwrap() {
                                    tokio::spawn(register(pool, project, runtime, lease, instance, endpoint));
                                }
                                Json(json!({ "message": "ensured" }))
                            }
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
            Some(instance),
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

    /// The next census calls answer these, in order (`None`: the call
    /// fails).
    fn script_census(&self, answers: Vec<Option<JsonValue>>) {
        *self.node.census_script.lock().unwrap() = answers;
    }

    fn after_releases(&self, censuses: Vec<JsonValue>) {
        *self.node.after_release.lock().unwrap() = censuses;
    }

    fn checkout(&self, runtime_present: bool, clean: bool, unpushed: &[&str]) -> JsonValue {
        json!({
            "projectId": self.project_id,
            "runtimePresent": runtime_present,
            "stoppedCleanly": clean,
            "unpushedRefs": unpushed.len(),
            "unpushedRefNames": unpushed,
            "unreadable": null,
            "empty": false,
        })
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
    instance: Option<Uuid>,
    endpoint: String,
) {
    let connection = pool.get().await.expect("connection");
    let instance = match instance {
        Some(instance) => instance,
        None => {
            let instance = Uuid::new_v4();
            connection
                .execute(
                    "insert into origin_instances
                        (id, project_id, runtime_id, lease_id, required, mode, status)
                     values ($1, $2, $3, $4, true, 'hosted', 'requested')",
                    &[&instance, &project, &runtime, &lease],
                )
                .await
                .expect("origin instance");
            instance
        }
    };
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
/// a 401, a user (even the space owner) or a scoped token a 403.
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
        let routes: [(&str, &str, Option<JsonValue>); 4] = [
            ("GET", "/operator/runtime-drain/census", None),
            ("POST", "/operator/runtime-drain/fence", Some(json!({ "fenced": true, "ttlSeconds": 60 }))),
            (
                "POST",
                "/operator/runtime-drain/stop",
                Some(json!({ "runtimeId": fx.runtime_id, "projectId": fx.project_id, "leaseId": Uuid::new_v4() })),
            ),
            (
                "POST",
                "/operator/runtime-drain/flush-checkout",
                Some(json!({ "projectId": fx.project_id })),
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
        assert!(fx.node.ensured.lock().unwrap().is_empty());
        let (status, census) = fx
            .call("GET", "/operator/runtime-drain/census", SERVICE, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{census}");
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// The census joins the node with the database: the runtime's active
/// generation is `live`, any other container an `orphan`, and a checkout
/// without a runtime needs a flush unless nothing on it is only there.
#[tokio::test]
async fn the_census_tells_live_runtimes_orphans_and_checkouts_needing_a_flush() -> anyhow::Result<()>
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
        let other_project = Uuid::new_v4();
        let clean_project = Uuid::new_v4();
        let crashed_project = Uuid::new_v4();
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
                    "projectId": crashed_project,
                    "runtimeId": Uuid::new_v4(),
                    "leaseId": Uuid::new_v4(),
                    "running": false,
                },
            ],
            "checkouts": [
                fx.checkout(true, false, &[]),
                {
                    "projectId": other_project,
                    "runtimePresent": false,
                    "stoppedCleanly": true,
                    "unpushedRefs": 1,
                    "unpushedRefNames": ["20261003T101010Z-unsaved-abc"],
                    "unreadable": null,
                    "empty": false,
                },
                {
                    "projectId": clean_project,
                    "runtimePresent": false,
                    "stoppedCleanly": true,
                    "unpushedRefs": 0,
                    "unpushedRefNames": [],
                    "unreadable": null,
                    "empty": false,
                },
                {
                    "projectId": crashed_project,
                    "runtimePresent": true,
                    "stoppedCleanly": false,
                    "unpushedRefs": 1,
                    "unpushedRefNames": ["20261003T101010Z-unsaved-def"],
                    "unreadable": null,
                    "empty": false,
                },
            ],
        }));
        let (status, census) = fx
            .call("GET", "/operator/runtime-drain/census", SERVICE, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{census}");
        assert_eq!(census["fenced"], false);
        assert_eq!(census["complete"], true, "{census}");
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
        let live = runtimes
            .iter()
            .find(|runtime| runtime["class"] == "live")
            .unwrap();
        assert_eq!(live["dbActiveLeaseId"], json!(lease));
        assert_eq!(live["dbStatus"], "ready");

        let checkouts = census["checkouts"].as_array().unwrap();
        let needs = |project: Uuid| {
            checkouts
                .iter()
                .find(|checkout| checkout["projectId"] == json!(project))
                .map(|checkout| checkout["needsFlush"].as_bool().unwrap())
        };
        assert_eq!(needs(fx.project_id), Some(false), "its runtime drains it");
        assert_eq!(needs(other_project), Some(true));
        assert_eq!(needs(clean_project), Some(false));
        assert_eq!(
            needs(crashed_project),
            Some(true),
            "a stopped container flushes nothing"
        );
        let own = checkouts
            .iter()
            .find(|checkout| checkout["projectId"] == json!(fx.project_id))
            .unwrap();
        assert_eq!(own["runtimeId"], json!(fx.runtime_id));

        // A provider that cannot list its node leaves the census incomplete.
        fx.set_census(json!({ "supported": false }));
        let (_, census) = fx
            .call("GET", "/operator/runtime-drain/census", SERVICE, None)
            .await;
        assert_eq!(census["complete"], false, "{census}");
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// A drain stop refuses any generation but the one it names, and otherwise
/// flushes under the owner's save-only permission (nobody holds a workspace
/// lease), releases the runtime and reports the flush and the checkout.
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
        let mut census = fx.node.census.lock().unwrap().clone();
        census["checkouts"] = json!([fx.checkout(true, false, &[])]);
        fx.set_census(census);
        fx.after_releases(vec![json!({
            "supported": true,
            "containers": [],
            "checkouts": [fx.checkout(false, true, &[])],
        })]);

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
                Some(json!({ "runtimeId": fx.runtime_id, "projectId": fx.project_id, "leaseId": lease })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{stopped}");
        assert_eq!(stopped["statusChanged"], true, "{stopped}");
        assert_eq!(
            stopped["flush"],
            json!({ "status": "flushed", "unpushedRefs": 0, "unpushedRefNames": [] })
        );
        assert_eq!(stopped["checkout"]["stoppedCleanly"], true, "{stopped}");
        assert_eq!(stopped["checkout"]["needsFlush"], false, "{stopped}");
        let flushes = fx.flushes.lock().unwrap().clone();
        assert_eq!(flushes.len(), 1, "{flushes:?}");
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
        assert_eq!(drained[1]["action"], "pool_retirement_drain");
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

        // No runtime starts.
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
        let refused = super::super::ensure::ensure_runtime_for_drain_flush(&fx.state, &other)
            .await
            .expect_err("a fenced controller starts nothing");
        assert_eq!(refused.0, StatusCode::SERVICE_UNAVAILABLE);
        let (_, Json(refusal)) = refused;
        assert_eq!(refusal.code.as_deref(), Some("controller_retiring"));
        assert!(fx.node.ensured.lock().unwrap().is_empty());

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

/// A stopped checkout still holding unpushed work: the drain releases an
/// orphan container of an older generation, wakes the space's runtime on
/// this node (even while fenced), which leases no job while it runs and is
/// never billed, flushes it under the owner's save-only permission, stops
/// it, and reports the checkout clean.
#[tokio::test]
async fn flush_checkout_wakes_flushes_and_stops_without_jobs_or_billing() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime drain flush-checkout test").await?;
    let project_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
        let orphan_lease = Uuid::new_v4();
        fx.set_census(json!({
            "supported": true,
            "containers": [{
                "composeProject": "instafy-runtime-orphan",
                "projectId": fx.project_id,
                "runtimeId": fx.runtime_id,
                "leaseId": orphan_lease,
                "running": false,
            }],
            "checkouts": [fx.checkout(true, false, &["20261003T101010Z-unsaved-abc"])],
        }));
        // After the orphan's release the checkout still holds its refs;
        // after the woken runtime's stop it is clean.
        fx.after_releases(vec![
            json!({
                "supported": true,
                "containers": [],
                "checkouts": [fx.checkout(false, false, &["20261003T101010Z-unsaved-abc"])],
            }),
            json!({
                "supported": true,
                "containers": [],
                "checkouts": [fx.checkout(false, true, &[])],
            }),
        ]);
        let job_id = Uuid::new_v4();
        fx.pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs (id, project_id, status, payload)
                 values ($1, $2, 'queued', '{}'::jsonb)",
                &[&job_id, &fx.project_id],
            )
            .await?;
        let (status, _) = fx
            .call(
                "POST",
                "/operator/runtime-drain/fence",
                SERVICE,
                Some(json!({ "fenced": true, "ttlSeconds": 600 })),
            )
            .await;
        assert_eq!(status, StatusCode::OK);

        let (status, flushed) = fx
            .call(
                "POST",
                "/operator/runtime-drain/flush-checkout",
                SERVICE,
                Some(json!({ "projectId": fx.project_id })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{flushed}");
        assert_eq!(flushed["status"], "flushed", "{flushed}");
        assert_eq!(flushed["runtimeId"], json!(fx.runtime_id));
        assert_eq!(
            flushed["releasedOrphans"],
            json!(["instafy-runtime-orphan"])
        );
        assert_eq!(flushed["flush"]["status"], "flushed", "{flushed}");
        assert_eq!(flushed["checkout"]["needsFlush"], false, "{flushed}");

        let released = fx.node.released.lock().unwrap().clone();
        assert_eq!(released.len(), 2, "{released:?}");
        assert_eq!(
            released[0]["lease_id"],
            json!(orphan_lease),
            "the orphan first, by its own generation"
        );
        let ensured = fx.node.ensured.lock().unwrap().clone();
        assert_eq!(ensured.len(), 1, "woken once, while fenced");
        let woken_lease: Uuid = serde_json::from_value(ensured[0]["lease_id"].clone())?;
        assert_eq!(released[1]["lease_id"], json!(woken_lease));

        let flushes = fx.flushes.lock().unwrap().clone();
        assert_eq!(flushes.len(), 1, "{flushes:?}");
        assert_eq!(flushes[0].git_write, StatusCode::OK);
        assert_eq!(
            flushes[0].leasable_jobs,
            Some(0),
            "the woken runtime leases no job"
        );
        let job_status: String = fx
            .pool
            .get()
            .await?
            .query_one("select status from agent_jobs where id = $1", &[&job_id])
            .await?
            .get(0);
        assert_eq!(job_status, "queued");
        assert_eq!(
            fx.events("pool_retirement_flush_wake").await?,
            vec![
                json!({ "phase": "starting" }),
                json!({ "phase": "started", "runtimeLeaseId": woken_lease }),
            ]
        );
        assert_eq!(fx.runtime_row().await?.0, "stopped");
        assert!(!fx.state.runtime_drain.is_flush_wake(&fx.runtime_id));
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// A checkout whose space runs on another node is not this drain's to
/// flush, and one with nothing left only here needs nothing.
#[tokio::test]
async fn flush_checkout_leaves_spaces_running_elsewhere_and_clean_checkouts() -> anyhow::Result<()>
{
    let pool = crate::tests::require_origin_test_pool("runtime drain busy test").await?;
    let project_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
        fx.set_census(json!({
            "supported": true,
            "containers": [],
            "checkouts": [fx.checkout(false, true, &[])],
        }));
        let (_, clean) = fx
            .call(
                "POST",
                "/operator/runtime-drain/flush-checkout",
                SERVICE,
                Some(json!({ "projectId": fx.project_id })),
            )
            .await;
        assert_eq!(clean["status"], "clean", "{clean}");

        // Its live generation is not on this node.
        fx.start_live().await?;
        fx.set_census(json!({
            "supported": true,
            "containers": [],
            "checkouts": [fx.checkout(false, false, &["x-unsaved-1"])],
        }));
        let (_, busy) = fx
            .call(
                "POST",
                "/operator/runtime-drain/flush-checkout",
                SERVICE,
                Some(json!({ "projectId": fx.project_id })),
            )
            .await;
        assert_eq!(busy["status"], "busy_elsewhere", "{busy}");
        assert!(fx.node.ensured.lock().unwrap().is_empty());
        assert!(fx.node.released.lock().unwrap().is_empty());
        assert!(fx.flushes.lock().unwrap().is_empty());
        assert_eq!(fx.runtime_row().await?.0, "ready");
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}

/// No controller bills a generation a drain woke only to flush a checkout,
/// from the moment its start is marked (before its lease exists) to its
/// stop; a start marker only covers launches within minutes of it, and the
/// space's other runtimes are billed as before.
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

/// A census that cannot say what a checkout holds is never read as clean:
/// one cut short at its bound, one that fails before the wake, and one that
/// fails after the woken runtime's stop all answer `failed` with the reason,
/// and the stop route says `ok: false` with `checkoutError`.
#[tokio::test]
async fn an_unknown_census_is_never_read_as_clean() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime drain unknown census test").await?;
    for case in [
        "truncated",
        "fails_before_wake",
        "fails_after_stop",
        "stop_route",
    ] {
        let project_id = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
            let dirty = json!({
                "supported": true,
                "containers": [],
                "checkouts": [fx.checkout(false, false, &["20261003T101010Z-unsaved-abc"])],
            });
            if case == "stop_route" {
                let lease = fx.start_live().await?;
                fx.script_census(vec![None]);
                let (status, stopped) = fx
                    .call(
                        "POST",
                        "/operator/runtime-drain/stop",
                        SERVICE,
                        Some(json!({
                            "runtimeId": fx.runtime_id,
                            "projectId": fx.project_id,
                            "leaseId": lease,
                        })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{stopped}");
                assert_eq!(stopped["ok"], false, "{stopped}");
                assert_eq!(stopped["statusChanged"], true, "{stopped}");
                assert_eq!(
                    stopped["checkoutError"], "the provider did not answer the census",
                    "{stopped}"
                );
                assert_eq!(stopped["checkout"], JsonValue::Null);
                let events = fx.events("pool_retirement_drain").await?;
                assert_eq!(events.last().unwrap()["checkoutKnown"], false, "{events:?}");
                return Ok(());
            }
            // The calls: the route's own census, the look before the wake,
            // the stop's look and the look after it.
            match case {
                "truncated" => fx.set_census(json!({
                    "supported": true,
                    "truncated": true,
                    "containers": [],
                    "checkouts": [],
                })),
                "fails_before_wake" => fx.script_census(vec![Some(dirty.clone()), None]),
                _ => fx.script_census(vec![Some(dirty.clone()), Some(dirty.clone()), None, None]),
            }
            let (status, flushed) = fx
                .call(
                    "POST",
                    "/operator/runtime-drain/flush-checkout",
                    SERVICE,
                    Some(json!({ "projectId": fx.project_id })),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{case}: {flushed}");
            assert_eq!(flushed["status"], "failed", "{case}: {flushed}");
            assert_eq!(
                flushed["error"],
                match case {
                    "truncated" => "the provider's census was cut short",
                    _ => "the provider did not answer the census",
                },
                "{case}: {flushed}"
            );
            let ensured = fx.node.ensured.lock().unwrap().len();
            if case == "fails_after_stop" {
                assert_eq!(ensured, 1, "{case}: woken and stopped");
                assert_eq!(flushed["flush"]["status"], "flushed", "{flushed}");
                assert_eq!(fx.runtime_row().await?.0, "stopped");
            } else {
                assert_eq!(ensured, 0, "{case}: nothing is woken on an unknown census");
                assert!(fx.flushes.lock().unwrap().is_empty(), "{case}");
            }
            Ok(())
        })
        .await;
        delete_users(&[owner]).await?;
        result?;
    }
    Ok(())
}

/// A woken runtime whose origin never comes online is stopped again and
/// answered `wake_failed`, not `flushed`.
#[tokio::test]
async fn flush_checkout_answers_wake_failed_when_the_origin_never_comes_online(
) -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime drain wake failure test").await?;
    let project_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = DrainFixture::new(pool.clone(), project_id, owner).await?;
        *fx.node.never_registers.lock().unwrap() = true;
        fx.set_census(json!({
            "supported": true,
            "containers": [],
            "checkouts": [fx.checkout(false, false, &["20261003T101010Z-unsaved-abc"])],
        }));
        // Whatever the census says after the stop, the wake failed.
        fx.after_releases(vec![json!({
            "supported": true,
            "containers": [],
            "checkouts": [fx.checkout(false, true, &[])],
        })]);
        let (status, flushed) = fx
            .call(
                "POST",
                "/operator/runtime-drain/flush-checkout",
                SERVICE,
                Some(json!({ "projectId": fx.project_id })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{flushed}");
        assert_eq!(flushed["status"], "wake_failed", "{flushed}");
        assert_eq!(fx.node.ensured.lock().unwrap().len(), 1);
        assert!(fx.flushes.lock().unwrap().is_empty(), "nothing to flush");
        assert_eq!(fx.node.released.lock().unwrap().len(), 1, "stopped again");
        assert_ne!(fx.runtime_row().await?.0, "ready");
        assert!(!fx.state.runtime_drain.is_flush_wake(&fx.runtime_id));
        Ok(())
    })
    .await;
    delete_users(&[owner]).await?;
    result
}
