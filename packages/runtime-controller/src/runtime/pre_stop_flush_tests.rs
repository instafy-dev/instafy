//! Database-backed tests of the pre-stop flush: a real controller state on
//! the shared test database, a stand-in runtime origin and a stand-in
//! provider. The stand-in origin does what the real one does with the
//! controller's token: it checks the workspace lease and mints `git.write`
//! through the controller's own routes. While the flush runs it can also do
//! what the rest of the world might do at that moment: a collaborator takes
//! a workspace lease or pings activity, or a job is leased to the runtime.
//! It records every `/git/flush/resume` the controller sends after a stop
//! that did not happen. The stand-in provider says where the origin is
//! (`/runtime/origin`), as the node's provider does.

use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::Json;
use serde_json::{json, Value as JsonValue};
use tower::ServiceExt as _;
use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, spawn_aborting, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, AbortingTask, SharedDbFixture,
};
use crate::tokens::{decode_scoped_token, mint_scoped_token, ScopedTokenRequest};
use crate::AppState;

/// What the stand-in origin saw when the controller called `/git/flush`.
#[derive(Debug, Clone)]
struct FlushCall {
    bearer: String,
    body: JsonValue,
    /// Database state at that moment.
    runtime_status: String,
    runtime_lease_status: String,
    job_statuses: Vec<String>,
    /// The origin's lease check and git token requests, answered by the
    /// controller's own routes.
    lease_check: StatusCode,
    lease: JsonValue,
    git_write: StatusCode,
    git_write_body: JsonValue,
    machine_git_write: StatusCode,
    /// A collaborator's workspace lease taken while the flush ran.
    collaborator_lease: Option<bool>,
}

/// What happens elsewhere while the stand-in origin flushes.
#[derive(Debug, Clone, Copy, Default)]
struct DuringFlush {
    /// A user's activity ping for the space.
    activity: bool,
    /// A job leased to the runtime.
    lease_job: bool,
}

#[derive(Clone)]
struct OriginStub {
    state: AppState,
    pool: PgPool,
    project_id: Uuid,
    runtime_id: Uuid,
    runtime_lease_id: Uuid,
    machine_token: String,
    response: JsonValue,
    calls: Arc<Mutex<Vec<FlushCall>>>,
    order: Arc<Mutex<Vec<&'static str>>>,
    collaborator: Arc<Mutex<Option<Uuid>>>,
    during: Arc<Mutex<DuringFlush>>,
    resumes: Arc<Mutex<Vec<String>>>,
}

async fn send(state: &AppState, request: Request<Body>) -> (StatusCode, JsonValue) {
    let response = crate::origins::router()
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

fn git_token_request(project_id: Uuid, bearer: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/projects/{project_id}/git/access_token"))
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "scopes": ["git.read", "git.write"], "ttlSeconds": 60 }).to_string(),
        ))
        .expect("git token request")
}

async fn handle_flush(
    State(stub): State<OriginStub>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Json<JsonValue> {
    stub.order.lock().unwrap().push("flush");
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let (runtime_status, runtime_lease_status, job_statuses) = {
        let connection = stub.pool.get().await.expect("stub connection");
        let row = connection
            .query_one(
                "select r.status as runtime_status, l.status as lease_status
                 from runtimes r
                 join runtime_leases l on l.id = $2
                 where r.id = $1",
                &[&stub.runtime_id, &stub.runtime_lease_id],
            )
            .await
            .expect("runtime state");
        let jobs = connection
            .query(
                "select status from agent_jobs where project_id = $1",
                &[&stub.project_id],
            )
            .await
            .expect("job state");
        (
            row.get::<_, String>("runtime_status"),
            row.get::<_, String>("lease_status"),
            jobs.iter()
                .map(|row| row.get::<_, String>("status"))
                .collect(),
        )
    };
    let (lease_check, lease) = send(
        &stub.state,
        Request::builder()
            .method("GET")
            .uri(format!("/projects/{}/lease", stub.project_id))
            .header("authorization", format!("Bearer {bearer}"))
            .body(Body::empty())
            .expect("lease request"),
    )
    .await;
    let (git_write, git_write_body) =
        send(&stub.state, git_token_request(stub.project_id, &bearer)).await;
    let (machine_git_write, _) = send(
        &stub.state,
        git_token_request(stub.project_id, &stub.machine_token),
    )
    .await;
    let collaborator = *stub.collaborator.lock().unwrap();
    let collaborator_lease = match collaborator {
        Some(user) => Some(matches!(
            crate::origins::acquire_lease(
                &stub.pool,
                &stub.project_id,
                Some(&user),
                None,
                300,
                None
            )
            .await
            .expect("collaborator lease"),
            crate::origins::LeaseAcquireOutcome::Granted(_)
        )),
        None => None,
    };
    let during = *stub.during.lock().unwrap();
    if during.activity || during.lease_job {
        let connection = stub.pool.get().await.expect("stub connection");
        if during.activity {
            connection
                .execute(
                    "insert into project_user_activity (project_id, last_active_at)
                     values ($1, now())
                     on conflict (project_id) do update set last_active_at = now()",
                    &[&stub.project_id],
                )
                .await
                .expect("activity ping");
        }
        if during.lease_job {
            connection
                .execute(
                    "insert into agent_jobs
                        (id, project_id, status, payload, leased_by_runtime_id,
                         leased_at, lease_expires_at)
                     values ($1, $2, 'leased', '{}'::jsonb, $3, now(),
                             now() + interval '5 minutes')",
                    &[&Uuid::new_v4(), &stub.project_id, &stub.runtime_id],
                )
                .await
                .expect("job leased during the flush");
        }
    }
    stub.calls.lock().unwrap().push(FlushCall {
        bearer,
        body,
        runtime_status,
        runtime_lease_status,
        job_statuses,
        lease_check,
        lease,
        git_write,
        git_write_body,
        machine_git_write,
        collaborator_lease,
    });
    Json(stub.response.clone())
}

async fn handle_resume(State(stub): State<OriginStub>, headers: HeaderMap) -> StatusCode {
    stub.order.lock().unwrap().push("resume");
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    stub.resumes.lock().unwrap().push(bearer);
    StatusCode::OK
}

struct Fixture {
    pool: PgPool,
    state: AppState,
    owner_user_id: Uuid,
    project_id: Uuid,
    runtime_id: Uuid,
    runtime_lease_id: Uuid,
    origin_id: Uuid,
    calls: Arc<Mutex<Vec<FlushCall>>>,
    order: Arc<Mutex<Vec<&'static str>>>,
    collaborator: Arc<Mutex<Option<Uuid>>>,
    during: Arc<Mutex<DuringFlush>>,
    resumes: Arc<Mutex<Vec<String>>>,
    /// What the stand-in provider answers on `/runtime/origin`: the stand-in
    /// origin's address, or nothing (404).
    attested: Arc<Mutex<Option<String>>>,
    /// The `/runtime/origin` questions the provider got.
    origin_asks: Arc<Mutex<Vec<JsonValue>>>,
    _provider: AbortingTask<()>,
    _origin: AbortingTask<()>,
}

impl Fixture {
    /// A ready provider-managed runtime with an online hosted origin for
    /// `project_id`, owned by `owner_user_id`. The origin answers every flush
    /// with `response`.
    async fn new(
        pool: PgPool,
        project_id: Uuid,
        owner_user_id: Uuid,
        response: JsonValue,
    ) -> anyhow::Result<Self> {
        Self::new_with(pool, project_id, owner_user_id, response, |_| {}).await
    }

    /// [`Self::new`] with `configure` applied to the controller's config.
    async fn new_with(
        pool: PgPool,
        project_id: Uuid,
        owner_user_id: Uuid,
        response: JsonValue,
        configure: impl FnOnce(&mut crate::config::AppConfig),
    ) -> anyhow::Result<Self> {
        let order = Arc::new(Mutex::new(Vec::new()));
        let attested: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let origin_asks = Arc::new(Mutex::new(Vec::new()));
        let provider_app = axum::Router::new()
            .route(
                "/runtime/release",
                axum::routing::post({
                    let order = order.clone();
                    move || {
                        let order = order.clone();
                        async move {
                            order.lock().unwrap().push("release");
                            StatusCode::NO_CONTENT
                        }
                    }
                }),
            )
            .route(
                "/runtime/origin",
                axum::routing::post({
                    let attested = attested.clone();
                    let origin_asks = origin_asks.clone();
                    move |Json(body): Json<JsonValue>| {
                        let attested = attested.clone();
                        let origin_asks = origin_asks.clone();
                        async move {
                            origin_asks.lock().unwrap().push(body);
                            let endpoint = attested.lock().unwrap().clone();
                            match endpoint {
                                Some(endpoint) => Ok(Json(json!({ "endpoint": endpoint }))),
                                None => Err(StatusCode::NOT_FOUND),
                            }
                        }
                    }
                }),
            );
        let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let provider_address = provider_listener.local_addr()?;
        let provider = spawn_aborting(async move {
            axum::serve(provider_listener, provider_app)
                .await
                .expect("serve stand-in provider");
        });

        let provider_id = "pre_stop_flush_test";
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "pre-stop-flush",
        );
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: provider_id.to_string(),
            display_name: "Stand-in provider".to_string(),
            kind: "test".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some(format!("http://{provider_address}")),
            auth_token: None,
            metadata: None,
        }];
        configure(&mut config);
        let state = build_test_state(pool.clone(), config);

        let runtime_id = Uuid::new_v4();
        let runtime_lease_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let machine_token = mint_scoped_token(
            &state.config,
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
        .map_err(|(_, body)| anyhow::anyhow!("mint machine token: {}", body.0.message))?
        .token;

        let calls = Arc::new(Mutex::new(Vec::new()));
        let collaborator = Arc::new(Mutex::new(None));
        let during = Arc::new(Mutex::new(DuringFlush::default()));
        let resumes = Arc::new(Mutex::new(Vec::new()));
        let origin_app = axum::Router::new()
            .route("/git/flush", axum::routing::post(handle_flush))
            .route("/git/flush/resume", axum::routing::post(handle_resume))
            .with_state(OriginStub {
                state: state.clone(),
                pool: pool.clone(),
                project_id,
                runtime_id,
                runtime_lease_id,
                machine_token,
                response,
                calls: calls.clone(),
                order: order.clone(),
                collaborator: collaborator.clone(),
                during: during.clone(),
                resumes: resumes.clone(),
            });
        let origin_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let origin_endpoint = format!("http://{}", origin_listener.local_addr()?);
        *attested.lock().unwrap() = Some(origin_endpoint.clone());
        let origin = spawn_aborting(async move {
            axum::serve(origin_listener, origin_app)
                .await
                .expect("serve stand-in origin");
        });

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
                "insert into runtimes
                    (id, project_id, provider, status, endpoint_url,
                     idle_ttl_seconds, last_seen_at)
                 values ($1, $2, $3, 'ready', 'http://runtime.test', 600, now())",
                &[&runtime_id, &project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at, launched_at)
                 values ($1, $2, $3, 'active', now(), now())",
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
                "insert into workspace_origins (id, project_id, mode, endpoint, protocols)
                 values ($1, $2, 'hosted', $3, array['http']::text[])",
                &[&origin_id, &project_id, &origin_endpoint],
            )
            .await?;
        connection
            .execute(
                "insert into origin_instances
                    (project_id, runtime_id, lease_id, origin_id, required,
                     mode, status, endpoint, protocols, metadata)
                 values ($1, $2, $3, $4, true, 'hosted', 'online', $5,
                         array['http']::text[], '{}'::jsonb)",
                &[
                    &project_id,
                    &runtime_id,
                    &runtime_lease_id,
                    &origin_id,
                    &origin_endpoint,
                ],
            )
            .await?;
        drop(connection);

        Ok(Self {
            pool,
            state,
            owner_user_id,
            project_id,
            runtime_id,
            runtime_lease_id,
            origin_id,
            calls,
            order,
            collaborator,
            during,
            resumes,
            attested,
            origin_asks,
            _provider: provider,
            _origin: origin,
        })
    }

    fn resumes(&self) -> Vec<String> {
        self.resumes.lock().unwrap().clone()
    }

    fn flush_calls(&self) -> Vec<FlushCall> {
        self.calls.lock().unwrap().clone()
    }

    fn order(&self) -> Vec<&'static str> {
        self.order.lock().unwrap().clone()
    }

    async fn insert_leased_job(&self) -> anyhow::Result<Uuid> {
        let job_id = Uuid::new_v4();
        self.pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs
                    (id, project_id, status, payload, leased_by_runtime_id,
                     leased_at, lease_expires_at)
                 values ($1, $2, 'leased', '{}'::jsonb, $3, now(),
                         now() + interval '5 minutes')",
                &[&job_id, &self.project_id, &self.runtime_id],
            )
            .await?;
        Ok(job_id)
    }

    async fn runtime_state(&self) -> anyhow::Result<(String, Option<Uuid>, String)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select r.status as runtime_status, r.active_lease_id,
                        l.status as lease_status
                 from runtimes r
                 join runtime_leases l on l.id = $2
                 where r.id = $1",
                &[&self.runtime_id, &self.runtime_lease_id],
            )
            .await?;
        Ok((
            row.get("runtime_status"),
            row.get("active_lease_id"),
            row.get("lease_status"),
        ))
    }

    async fn flush_events(&self) -> anyhow::Result<Vec<JsonValue>> {
        Ok(self
            .pool
            .get()
            .await?
            .query(
                "select data from runtime_events
                 where runtime_id = $1 and kind = 'workspace_flush'
                 order by id",
                &[&self.runtime_id],
            )
            .await?
            .iter()
            .map(|row| row.get("data"))
            .collect())
    }

    /// A workspace lease for the owner, bound to this runtime, as a turn's
    /// checkpoint or a user's edit holds one.
    async fn hold_owner_lease(&self) -> anyhow::Result<Uuid> {
        match crate::origins::acquire_lease(
            &self.pool,
            &self.project_id,
            Some(&self.owner_user_id),
            Some(&self.runtime_id),
            300,
            None,
        )
        .await?
        {
            crate::origins::LeaseAcquireOutcome::Granted(lease) => Ok(lease.id),
            other => anyhow::bail!("expected a new workspace lease, got {other:?}"),
        }
    }

    async fn insert_job(&self, status: &str, completed_seconds_ago: i64) -> anyhow::Result<Uuid> {
        let job_id = Uuid::new_v4();
        self.pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs
                    (id, project_id, status, payload, leased_by_runtime_id,
                     leased_at, completed_at)
                 values ($1, $2, $3, '{}'::jsonb, $4, now() - interval '5 minutes',
                         now() - make_interval(secs => $5::double precision))",
                &[
                    &job_id,
                    &self.project_id,
                    &status,
                    &self.runtime_id,
                    &(completed_seconds_ago as f64),
                ],
            )
            .await?;
        Ok(job_id)
    }

    /// The workspace leases of the project, as (id, user, runtime, status).
    async fn workspace_leases(
        &self,
    ) -> anyhow::Result<Vec<(Uuid, Option<Uuid>, Option<Uuid>, String)>> {
        Ok(self
            .pool
            .get()
            .await?
            .query(
                "select id, user_id, runtime_id, status from workspace_leases
                 where project_id = $1
                 order by created_at",
                &[&self.project_id],
            )
            .await?
            .iter()
            .map(|row| {
                (
                    row.get("id"),
                    row.get("user_id"),
                    row.get("runtime_id"),
                    row.get("status"),
                )
            })
            .collect())
    }
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

/// A credit stop (or the idle reaper, or an ensure replacement) mid-turn,
/// with the owner holding the workspace lease: the controller mints an
/// fs.write token for that holder and calls `/git/flush` with `turnActive`
/// before the quarantine. The origin can mint git.write with that token,
/// while the runtime's machine token still cannot.
#[tokio::test]
async fn safe_stop_flushes_the_workspace_before_the_quarantine() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush safe stop test").await?;
    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = Fixture::new(
            pool.clone(),
            project_id,
            owner_user_id,
            json!({
                "recoveryRefs": [{ "name": "20261002T120000Z-unsaved-0123456789ab" }],
                "unpushedRefs": 0,
                "unpushedRefNames": [],
                "parkedCommits": 1,
            }),
        )
        .await?;
        fx.insert_leased_job().await?;
        let held = fx.hold_owner_lease().await?;

        let stopped = super::super::stop::stop_runtime_safely(
            &fx.state,
            &fx.runtime_id,
            super::super::stop::StopOptions {
                source: "pre_stop_flush_test",
                reason: Some("credits_exhausted".to_string()),
                skip_if_active_jobs: false,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert!(stopped.outcome.status_changed);

        assert_eq!(fx.order(), vec!["flush", "release"]);
        let calls = fx.flush_calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        let call = &calls[0];
        assert_eq!(
            call.body,
            json!({ "turnActive": true, "workingState": true })
        );
        // Before the quarantine: nothing is fenced yet and the turn's job is
        // still leased.
        assert_eq!(call.runtime_status, "ready");
        assert_eq!(call.runtime_lease_status, "active");
        assert_eq!(call.job_statuses, vec!["leased".to_string()]);

        let claims = decode_scoped_token(&fx.state.config, &call.bearer, "flush token")
            .map_err(|(_, body)| anyhow::anyhow!("decode flush token: {}", body.0.message))?;
        assert_eq!(claims.scopes, vec!["fs.write".to_string()]);
        assert_eq!(claims.aud, fx.origin_id.to_string());
        assert_eq!(claims.sub, fx.owner_user_id.to_string());
        assert_eq!(claims.project_id, fx.project_id.to_string());
        assert_eq!(claims.origin_id, Some(fx.origin_id.to_string()));
        assert_eq!(claims.runtime_id, Some(fx.runtime_id.to_string()));
        assert_eq!(claims.protocol.as_deref(), Some("http"));
        assert!(claims.run_id.is_none());
        assert!(claims.exp - claims.iat <= 60, "{claims:?}");

        let leases = fx.workspace_leases().await?;
        assert_eq!(leases.len(), 1, "no lease of its own: {leases:?}");
        let (lease_id, lease_user, lease_runtime, _) = &leases[0];
        assert_eq!(*lease_id, held);
        assert_eq!(claims.lease_id, Some(held.to_string()));
        assert_eq!(*lease_user, Some(fx.owner_user_id));
        assert_eq!(*lease_runtime, Some(fx.runtime_id));

        assert_eq!(call.lease_check, StatusCode::OK);
        assert_eq!(call.lease["lease"]["leaseId"], json!(held));
        assert_eq!(
            call.git_write,
            StatusCode::OK,
            "the lease holder mints git.write"
        );
        assert_eq!(
            call.machine_git_write,
            StatusCode::FORBIDDEN,
            "a machine token still cannot mint git.write"
        );

        let (runtime_status, active_lease, lease_status) = fx.runtime_state().await?;
        assert_eq!(runtime_status, "stopped");
        assert!(active_lease.is_none());
        assert_eq!(lease_status, "released");
        let jobs = fx
            .pool
            .get()
            .await?
            .query(
                "select status from agent_jobs where project_id = $1",
                &[&fx.project_id],
            )
            .await?;
        assert_eq!(jobs[0].get::<_, String>("status"), "queued");

        assert_eq!(
            fx.flush_events().await?,
            vec![json!({
                "status": "saved",
                "writer": "lease_holder",
                "turnActive": true,
                "unpushedRefs": 0,
                "recoveryRefs": 1,
                "parkedCommits": 1,
            })]
        );
        assert_eq!(stopped.flush.status, "flushed");
        assert_eq!(stopped.flush.unpushed_refs, Some(0));
        Ok(())
    })
    .await;
    delete_users(&[owner_user_id]).await?;
    result
}

/// A user's Stop: the flush runs under the workspace lease the user already
/// holds (and leaves it alone), with no turn running. Work the origin could
/// not push is reported as kept locally.
#[tokio::test]
async fn user_stop_flushes_under_the_existing_workspace_lease() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush user stop test").await?;
    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = Fixture::new(
            pool.clone(),
            project_id,
            owner_user_id,
            json!({
                "recoveryRefs": [],
                "unpushedRefs": 2,
                "unpushedRefNames": ["a-unsaved-1", "b-stale-2"],
                "parkedCommits": 0,
                "publish": { "gitSyncStatus": "published" },
            }),
        )
        .await?;
        let held = match crate::origins::acquire_lease(
            &fx.pool,
            &fx.project_id,
            Some(&fx.owner_user_id),
            Some(&fx.runtime_id),
            300,
            None,
        )
        .await?
        {
            crate::origins::LeaseAcquireOutcome::Granted(lease) => lease.id,
            other => anyhow::bail!("expected a new workspace lease, got {other:?}"),
        };

        let user_token = crate::auth::issue_controller_token(&fx.state.config, &fx.owner_user_id)
            .map_err(|(_, body)| anyhow::anyhow!("issue user token: {}", body.0.message))?
            .token;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {user_token}"))?,
        );
        let payload: super::super::stop::RuntimeStopPayload = serde_json::from_value(json!({
            "runtime_id": fx.runtime_id,
            "reason": "user_stop",
        }))?;
        let (status, Json(response)) =
            super::super::stop::runtime_stop(State(fx.state.clone()), headers, axum::Json(payload))
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert_eq!(status, StatusCode::OK, "{response:?}");
        assert!(response.status_changed);

        assert_eq!(fx.order(), vec!["flush", "release"]);
        let calls = fx.flush_calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        let call = &calls[0];
        assert_eq!(
            call.body,
            json!({ "turnActive": false, "workingState": true })
        );
        assert_eq!(call.runtime_status, "ready");
        let claims = decode_scoped_token(&fx.state.config, &call.bearer, "flush token")
            .map_err(|(_, body)| anyhow::anyhow!("decode flush token: {}", body.0.message))?;
        assert_eq!(claims.scopes, vec!["fs.write".to_string()]);
        assert_eq!(claims.lease_id, Some(held.to_string()));
        assert_eq!(claims.sub, fx.owner_user_id.to_string());
        assert_eq!(claims.runtime_id, Some(fx.runtime_id.to_string()));
        assert_eq!(call.git_write, StatusCode::OK);
        assert_eq!(call.machine_git_write, StatusCode::FORBIDDEN);

        let leases = fx.workspace_leases().await?;
        assert_eq!(leases.len(), 1, "no lease of its own: {leases:?}");
        assert_eq!(leases[0].0, held);
        assert_eq!(leases[0].3, "active", "the holder's lease is left alone");

        assert_eq!(
            fx.flush_events().await?,
            vec![json!({
                "status": "kept_locally",
                "writer": "lease_holder",
                "turnActive": false,
                "unpushedRefs": 2,
                "recoveryRefs": 0,
                "parkedCommits": 0,
                "gitSyncStatus": "published",
            })]
        );
        // The stop response carries the flush for a drain to read.
        let flush = response.flush.as_ref().expect("the stop reports its flush");
        assert_eq!(flush.status, "flushed");
        assert_eq!(flush.unpushed_refs, Some(2));
        assert_eq!(
            flush.unpushed_ref_names,
            vec!["a-unsaved-1".to_string(), "b-stale-2".to_string()]
        );
        assert_eq!(
            serde_json::to_value(&response)?["flush"],
            json!({
                "status": "flushed",
                "unpushedRefs": 2,
                "unpushedRefNames": ["a-unsaved-1", "b-stale-2"],
            })
        );
        assert_eq!(fx.runtime_state().await?.0, "stopped");
        Ok(())
    })
    .await;
    delete_users(&[owner_user_id]).await?;
    result
}

/// Someone who may not stop the runtime cannot make its origin flush, and a
/// stop the preconditions skip flushes nothing either.
#[tokio::test]
async fn refused_or_skipped_stops_do_not_flush() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush refusal test").await?;
    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let stranger_user_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = Fixture::new(
            pool.clone(),
            project_id,
            owner_user_id,
            json!({ "unpushedRefs": 0 }),
        )
        .await?;
        ensure_test_user(&fx.pool, &stranger_user_id).await?;

        let stranger_token =
            crate::auth::issue_controller_token(&fx.state.config, &stranger_user_id)
                .map_err(|(_, body)| anyhow::anyhow!("issue user token: {}", body.0.message))?
                .token;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {stranger_token}"))?,
        );
        let payload: super::super::stop::RuntimeStopPayload = serde_json::from_value(json!({
            "runtime_id": fx.runtime_id,
            "reason": "user_stop",
        }))?;
        let refused =
            super::super::stop::runtime_stop(State(fx.state.clone()), headers, axum::Json(payload))
                .await;
        assert!(refused.is_err(), "a stranger stopped the runtime");

        fx.insert_leased_job().await?;
        let skipped = super::super::stop::stop_runtime_safely(
            &fx.state,
            &fx.runtime_id,
            super::super::stop::StopOptions {
                source: "pre_stop_flush_test",
                reason: Some("idle".to_string()),
                skip_if_active_jobs: true,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert_eq!(skipped.outcome.skip_reason.as_deref(), Some("active_jobs"));

        assert!(fx.flush_calls().is_empty(), "{:?}", fx.flush_calls());
        assert!(fx.order().is_empty());
        assert!(fx.workspace_leases().await?.is_empty());
        assert!(fx.flush_events().await?.is_empty());
        assert_eq!(fx.runtime_state().await?.0, "ready");
        Ok(())
    })
    .await;
    delete_users(&[owner_user_id, stranger_user_id]).await?;
    result
}

/// An origin that cannot flush (an older runtime without the route, here a
/// 404) never holds up the stop.
#[tokio::test]
async fn a_failed_flush_does_not_hold_up_the_stop() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush failure test").await?;
    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = Fixture::new(pool.clone(), project_id, owner_user_id, json!({})).await?;
        let held = fx.hold_owner_lease().await?;
        // The provider places the origin at a path without the route.
        {
            let mut attested = fx.attested.lock().unwrap();
            let endpoint = attested.clone().expect("the stand-in origin");
            *attested = Some(format!("{endpoint}/legacy"));
        }
        let stopped = super::super::stop::stop_runtime_safely(
            &fx.state,
            &fx.runtime_id,
            super::super::stop::StopOptions {
                source: "pre_stop_flush_test",
                reason: Some("idle".to_string()),
                skip_if_active_jobs: true,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert!(stopped.outcome.status_changed);
        assert!(fx.flush_calls().is_empty());
        assert_eq!(fx.order(), vec!["release"]);
        assert_eq!(
            fx.flush_events().await?,
            vec![json!({ "status": "failed", "writer": "lease_holder", "turnActive": false })]
        );
        assert_eq!(stopped.flush.status, "failed");
        assert_eq!(
            stopped.flush.error.as_deref(),
            Some("origin_refused:404"),
            "a fixed code, never the origin's own text"
        );
        let leases = fx.workspace_leases().await?;
        assert_eq!(leases.len(), 1, "{leases:?}");
        assert_eq!(leases[0].0, held);
        assert_eq!(fx.runtime_state().await?.0, "stopped");
        Ok(())
    })
    .await;
    delete_users(&[owner_user_id]).await?;
    result
}

/// The space owner's save-only permission, as the controller mints it.
fn save_grant(fx: &Fixture, owner: Uuid, runtime_lease_id: Uuid, ttl: i64) -> String {
    mint_scoped_token(
        &fx.state.config,
        ScopedTokenRequest {
            audience: fx.origin_id.to_string(),
            subject: owner.to_string(),
            project_id: fx.project_id.to_string(),
            origin_id: Some(fx.origin_id.to_string()),
            runtime_id: Some(fx.runtime_id.to_string()),
            protocol: Some("http".to_string()),
            scopes: vec![super::PRE_STOP_SAVE_SCOPE.to_string()],
            lease_id: Some(runtime_lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(ttl),
        },
    )
    .expect("mint save grant")
    .token
}

/// Owner decision 1: an idle stop the controller makes on its own, with
/// nobody holding a workspace lease this runtime may save under (none at
/// all, or one bound to another runtime), saves under the space owner's
/// save-only permission: scope `workspace.flush` only, at most 120 s, bound
/// to the project, runtime generation and origin. The origin exchanges it
/// for git.write, which never outlives it; it opens nothing else and takes
/// no workspace lease.
#[tokio::test]
async fn an_idle_stop_saves_under_the_owners_save_only_permission() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush owner grant test").await?;
    for case in ["no_lease", "lease_on_another_runtime"] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let collaborator = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0, "unpushedRefNames": [] }),
            )
            .await?;
            ensure_test_user(&fx.pool, &collaborator).await?;
            fx.pool
                .get()
                .await?
                .execute(
                    "insert into project_memberships (project_id, user_id, role)
                     values ($1, $2, 'builder')",
                    &[&fx.project_id, &collaborator],
                )
                .await?;
            let other_runtime = Uuid::new_v4();
            if case == "lease_on_another_runtime" {
                // After a pool cutover the owner's lease is bound to the
                // runtime on the new node.
                fx.pool
                    .get()
                    .await?
                    .execute(
                        "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                         values ($1, $2, 'pre_stop_flush_test', 'stopped', 600)",
                        &[&other_runtime, &fx.project_id],
                    )
                    .await?;
                match crate::origins::acquire_lease(
                    &fx.pool,
                    &fx.project_id,
                    Some(&fx.owner_user_id),
                    Some(&other_runtime),
                    300,
                    None,
                )
                .await?
                {
                    crate::origins::LeaseAcquireOutcome::Granted(_) => {}
                    other => anyhow::bail!("expected a lease, got {other:?}"),
                }
            }

            let stopped = super::super::stop::stop_runtime_safely(
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
            assert!(stopped.outcome.status_changed, "{case}");
            assert_eq!(fx.order(), vec!["flush", "release"], "{case}");
            assert_eq!(stopped.flush.status, "flushed", "{case}");
            assert_eq!(stopped.flush.unpushed_refs, Some(0), "{case}");

            let calls = fx.flush_calls();
            assert_eq!(calls.len(), 1, "{case}: {calls:?}");
            let call = &calls[0];
            assert_eq!(call.runtime_status, "ready", "{case}");
            assert_eq!(call.runtime_lease_status, "active", "{case}");
            let claims = decode_scoped_token(&fx.state.config, &call.bearer, "save grant")
                .map_err(|(_, body)| anyhow::anyhow!("decode save grant: {}", body.0.message))?;
            assert_eq!(claims.scopes, vec!["workspace.flush".to_string()], "{case}");
            assert_eq!(claims.sub, fx.owner_user_id.to_string(), "{case}");
            assert_eq!(claims.aud, fx.origin_id.to_string(), "{case}");
            assert_eq!(claims.origin_id, Some(fx.origin_id.to_string()), "{case}");
            assert_eq!(claims.project_id, fx.project_id.to_string(), "{case}");
            assert_eq!(claims.runtime_id, Some(fx.runtime_id.to_string()), "{case}");
            assert_eq!(
                claims.lease_id,
                Some(fx.runtime_lease_id.to_string()),
                "{case}: bound to the runtime generation"
            );
            assert!(claims.exp - claims.iat <= 30, "{claims:?}");
            assert_ne!(
                call.lease_check,
                StatusCode::OK,
                "{case}: the permission reads no workspace lease"
            );
            assert_eq!(
                call.git_write,
                StatusCode::OK,
                "{case}: the origin exchanges it for git.write"
            );
            let git_token = call.git_write_body["token"].as_str().unwrap_or_default();
            let git_claims = decode_scoped_token(&fx.state.config, git_token, "git token")
                .map_err(|(_, body)| anyhow::anyhow!("decode git token: {}", body.0.message))?;
            assert!(git_claims.scopes.contains(&"git.write".to_string()));
            assert_eq!(git_claims.sub, fx.owner_user_id.to_string());
            // The origin asked for 60 s; the permission lives 30 s.
            assert!(
                git_claims.exp <= claims.exp,
                "the git token outlives the permission"
            );
            assert_eq!(call.machine_git_write, StatusCode::FORBIDDEN, "{case}");
            assert!(fx.resumes().is_empty(), "{case}: the stop happened");

            let leases = fx.workspace_leases().await?;
            assert!(
                leases
                    .iter()
                    .all(|(_, user, _, _)| *user != Some(fx.owner_user_id) || case != "no_lease"),
                "{case}: the permission takes no workspace lease: {leases:?}"
            );
            assert_eq!(
                fx.flush_events().await?,
                vec![json!({
                    "status": "saved",
                    "writer": "owner_grant",
                    "turnActive": false,
                    "unpushedRefs": 0,
                    "recoveryRefs": 0,
                    "parkedCommits": 0,
                })],
                "{case}"
            );
            assert_eq!(fx.runtime_state().await?.0, "stopped");
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id, collaborator]).await?;
        result?;
    }
    Ok(())
}

/// A stop a user, an operator or a runtime asked for never uses the owner's
/// permission: with nobody holding a workspace lease it mints nothing and
/// does not call the origin, and says so (`no_writer`). That holds for
/// `/runtime/stop`, `/runtime/remove` and a project's own stop alike. A
/// space without an owner gets nothing on the controller's own path either.
#[tokio::test]
async fn requested_stops_and_ownerless_spaces_mint_nothing() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush no-writer test").await?;
    for case in ["user_stop", "remove", "project_stop", "ownerless"] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0 }),
            )
            .await?;
            let user_headers = || -> anyhow::Result<HeaderMap> {
                let user_token =
                    crate::auth::issue_controller_token(&fx.state.config, &fx.owner_user_id)
                        .map_err(|(_, body)| {
                            anyhow::anyhow!("issue user token: {}", body.0.message)
                        })?
                        .token;
                let mut headers = HeaderMap::new();
                headers.insert(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {user_token}"))?,
                );
                Ok(headers)
            };
            let flush = match case {
                "user_stop" => {
                    let payload: super::super::stop::RuntimeStopPayload =
                        serde_json::from_value(json!({
                            "runtime_id": fx.runtime_id,
                            "reason": "user_stop",
                        }))?;
                    let (status, Json(response)) = super::super::stop::runtime_stop(
                        State(fx.state.clone()),
                        user_headers()?,
                        axum::Json(payload),
                    )
                    .await
                    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
                    assert_eq!(status, StatusCode::OK);
                    response.flush.expect("the stop reports its flush")
                }
                "remove" => {
                    let payload: super::super::stop::RuntimeRemovePayload =
                        serde_json::from_value(json!({
                            "runtimeId": fx.runtime_id,
                            "reason": "user_remove",
                        }))?;
                    let Json(removed) = super::super::stop::runtime_remove(
                        State(fx.state.clone()),
                        user_headers()?,
                        axum::Json(payload),
                    )
                    .await
                    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
                    assert!(removed.ok);
                    removed.flush.expect("the removal reports its flush")
                }
                "project_stop" => super::super::stop::stop_runtime_for_project(
                    &fx.state,
                    &fx.project_id,
                    &fx.runtime_id,
                    Some("operator_stop".to_string()),
                    "pre_stop_flush_test",
                )
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?
                .flush
                .expect("the stop reports its flush"),
                _ => {
                    fx.pool
                        .get()
                        .await?
                        .execute(
                            "update projects set owner_user_id = null where id = $1",
                            &[&fx.project_id],
                        )
                        .await?;
                    super::super::stop::stop_runtime_safely(
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
                    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?
                    .flush
                }
            };
            assert_eq!(flush.status, "no_writer", "{case}");
            assert_eq!(flush.unpushed_refs, None, "{case}: unknown");
            assert_eq!(flush.reason, None, "{case}");
            assert!(
                fx.flush_calls().is_empty(),
                "{case}: {:?}",
                fx.flush_calls()
            );
            assert_eq!(fx.order(), vec!["release"], "{case}");
            assert!(fx.workspace_leases().await?.is_empty(), "{case}");
            assert_eq!(
                fx.flush_events().await?,
                vec![json!({ "status": "no_writer", "writer": "none", "turnActive": false })],
                "{case}"
            );
            assert_eq!(
                fx.runtime_state().await?.0,
                if case == "remove" {
                    "removed"
                } else {
                    "stopped"
                },
                "{case}"
            );
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

/// The controller exchanges a save-only permission for git.write only while
/// everything it names still holds: the runtime's active, unquarantined
/// generation with that origin online, and the space owner who may write.
/// It never reads a workspace lease, and a machine token still never gets
/// git.write.
#[tokio::test]
async fn a_save_permission_mints_git_write_only_for_the_live_generation() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop save grant validation").await?;
    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = Fixture::new(pool.clone(), project_id, owner_user_id, json!({})).await?;
        ensure_test_user(&fx.pool, &stranger).await?;
        let grant = save_grant(&fx, fx.owner_user_id, fx.runtime_lease_id, 60);
        let mint = |bearer: String| {
            let state = fx.state.clone();
            let project_id = fx.project_id;
            async move { send(&state, git_token_request(project_id, &bearer)).await.0 }
        };
        assert_eq!(mint(grant.clone()).await, StatusCode::OK);
        let (lease_status, _) = send(
            &fx.state,
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{}/lease", fx.project_id))
                .header("authorization", format!("Bearer {grant}"))
                .body(Body::empty())?,
        )
        .await;
        assert_ne!(lease_status, StatusCode::OK, "it reads no workspace lease");

        // Another generation of the same runtime, someone else's name, or a
        // permission with any other scope: refused.
        assert_ne!(
            mint(save_grant(&fx, fx.owner_user_id, Uuid::new_v4(), 60)).await,
            StatusCode::OK
        );
        assert_ne!(
            mint(save_grant(&fx, stranger, fx.runtime_lease_id, 60)).await,
            StatusCode::OK
        );
        let widened = mint_scoped_token(
            &fx.state.config,
            ScopedTokenRequest {
                audience: fx.origin_id.to_string(),
                subject: fx.owner_user_id.to_string(),
                project_id: fx.project_id.to_string(),
                origin_id: Some(fx.origin_id.to_string()),
                runtime_id: Some(fx.runtime_id.to_string()),
                protocol: Some("http".to_string()),
                scopes: vec![
                    super::PRE_STOP_SAVE_SCOPE.to_string(),
                    crate::runtime::RUNTIME_TOKEN_GIT_MINT_SCOPE.to_string(),
                ],
                lease_id: Some(fx.runtime_lease_id.to_string()),
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(60),
            },
        )
        .map_err(|(_, body)| anyhow::anyhow!("{}", body.0.message))?
        .token;
        assert_ne!(mint(widened).await, StatusCode::OK);

        // The space changed hands: the old owner's permission is dead, even
        // when they stay on as a builder who may still write.
        let connection = fx.pool.get().await?;
        connection
            .execute(
                "update projects set owner_user_id = $2 where id = $1",
                &[&fx.project_id, &stranger],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&fx.project_id, &fx.owner_user_id],
            )
            .await?;
        assert_ne!(mint(grant.clone()).await, StatusCode::OK);
        connection
            .execute(
                "update projects set owner_user_id = $2 where id = $1",
                &[&fx.project_id, &fx.owner_user_id],
            )
            .await?;
        assert_eq!(mint(grant.clone()).await, StatusCode::OK);

        // Its origin went offline: refused.
        connection
            .execute(
                "update origin_instances set status = 'offline' where runtime_id = $1",
                &[&fx.runtime_id],
            )
            .await?;
        assert_ne!(mint(grant.clone()).await, StatusCode::OK);
        connection
            .execute(
                "update origin_instances set status = 'online' where runtime_id = $1",
                &[&fx.runtime_id],
            )
            .await?;
        assert_eq!(mint(grant.clone()).await, StatusCode::OK);

        // Quarantined by its stop: the permission dies with the generation.
        connection
            .execute(
                "update runtime_leases set status = 'cleanup_pending' where id = $1",
                &[&fx.runtime_lease_id],
            )
            .await?;
        assert_ne!(mint(grant.clone()).await, StatusCode::OK);
        drop(connection);
        Ok(())
    })
    .await;
    delete_users(&[owner_user_id, stranger]).await?;
    result
}

/// A stop that names the runtime generation it means (a drain reads it on
/// the node) skips any other generation before it flushes or fences
/// anything: after a cutover the same runtime row may run a newer
/// generation elsewhere.
#[tokio::test]
async fn a_stop_for_another_generation_is_skipped_untouched() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush lease guard test").await?;
    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = Fixture::new(
            pool.clone(),
            project_id,
            owner_user_id,
            json!({ "unpushedRefs": 0 }),
        )
        .await?;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer internal"),
        );
        let payload: super::super::stop::RuntimeStopPayload = serde_json::from_value(json!({
            "runtime_id": fx.runtime_id,
            "reason": "pool_retirement",
            "expected_project_id": fx.project_id,
            "expected_lease_id": Uuid::new_v4(),
        }))?;
        let (status, Json(response)) =
            super::super::stop::runtime_stop(State(fx.state.clone()), headers, axum::Json(payload))
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert_eq!(status, StatusCode::OK);
        assert!(!response.status_changed);
        assert_eq!(
            response.skip_reason.as_deref(),
            Some("runtime_lease_mismatch")
        );
        assert_eq!(
            response.flush.as_ref().map(|flush| flush.status),
            Some("skipped")
        );

        let skipped = super::super::stop::stop_runtime_safely(
            &fx.state,
            &fx.runtime_id,
            super::super::stop::StopOptions {
                source: "pool_retirement_drain",
                reason: Some("pool_retirement".to_string()),
                skip_if_active_jobs: false,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: Some(super::super::stop::RuntimeIdentityExpectation {
                    project_id: Some(fx.project_id),
                    provider: None,
                    display_name: None,
                    lease_id: Some(Uuid::new_v4()),
                }),
            },
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert_eq!(
            skipped.outcome.skip_reason.as_deref(),
            Some("runtime_lease_mismatch")
        );
        assert_eq!(skipped.flush.status, "skipped");

        assert!(fx.flush_calls().is_empty());
        assert!(fx.order().is_empty(), "nothing released: {:?}", fx.order());
        let (runtime_status, active_lease, lease_status) = fx.runtime_state().await?;
        assert_eq!(runtime_status, "ready");
        assert_eq!(active_lease, Some(fx.runtime_lease_id));
        assert_eq!(lease_status, "active", "never quarantined");
        Ok(())
    })
    .await;
    delete_users(&[owner_user_id]).await?;
    result
}

/// A turn cancelled moments before the stop (a user Stop) counts as an
/// active turn; one that ended long ago does not.
#[tokio::test]
async fn a_turn_cancelled_just_before_the_stop_is_still_active() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush cancelled turn test").await?;
    for (status, seconds_ago, expected) in [
        ("canceled", 5, true),
        ("canceled", 600, false),
        ("completed", 5, false),
    ] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0 }),
            )
            .await?;
            fx.insert_job(status, seconds_ago).await?;
            fx.hold_owner_lease().await?;
            super::super::stop::stop_runtime_safely(
                &fx.state,
                &fx.runtime_id,
                super::super::stop::StopOptions {
                    source: "pre_stop_flush_test",
                    reason: Some("user_stop".to_string()),
                    skip_if_active_jobs: false,
                    require_idle_timeout: false,
                    allow_cleanup_pending_release: false,
                    expected_identity: None,
                },
            )
            .await
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
            let calls = fx.flush_calls();
            assert_eq!(calls.len(), 1, "{status} {seconds_ago}s: {calls:?}");
            assert_eq!(
                calls[0].body,
                json!({ "turnActive": expected, "workingState": true }),
                "{status} {seconds_ago}s ago"
            );
            assert_eq!(fx.order(), vec!["flush", "release"]);
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

/// `/runtime/remove` and a project's own stop flush before they fence the
/// runtime, like every other stop.
#[tokio::test]
async fn remove_and_project_stops_flush_before_the_release() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush remove test").await?;
    for path in ["remove", "project_stop"] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0 }),
            )
            .await?;
            fx.hold_owner_lease().await?;
            match path {
                "remove" => {
                    let user_token =
                        crate::auth::issue_controller_token(&fx.state.config, &fx.owner_user_id)
                            .map_err(|(_, body)| {
                                anyhow::anyhow!("issue user token: {}", body.0.message)
                            })?
                            .token;
                    let mut headers = HeaderMap::new();
                    headers.insert(
                        axum::http::header::AUTHORIZATION,
                        HeaderValue::from_str(&format!("Bearer {user_token}"))?,
                    );
                    let payload: super::super::stop::RuntimeRemovePayload =
                        serde_json::from_value(json!({
                            "runtimeId": fx.runtime_id,
                            "reason": "user_remove",
                        }))?;
                    let Json(removed) = super::super::stop::runtime_remove(
                        State(fx.state.clone()),
                        headers,
                        axum::Json(payload),
                    )
                    .await
                    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
                    assert!(removed.ok);
                }
                _ => {
                    super::super::stop::stop_runtime_for_project(
                        &fx.state,
                        &fx.project_id,
                        &fx.runtime_id,
                        Some("project_stop".to_string()),
                        "pre_stop_flush_test",
                    )
                    .await
                    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
                }
            }
            assert_eq!(fx.order(), vec!["flush", "release"], "{path}");
            let calls = fx.flush_calls();
            assert_eq!(calls.len(), 1, "{path}: {calls:?}");
            assert_eq!(calls[0].runtime_status, "ready", "{path}");
            assert_eq!(calls[0].runtime_lease_status, "active", "{path}");
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

fn idle_reaper_stop() -> super::super::stop::StopOptions {
    super::super::stop::StopOptions {
        source: "idle_reaper",
        reason: Some("idle_timeout".to_string()),
        skip_if_active_jobs: true,
        require_idle_timeout: false,
        allow_cleanup_pending_release: false,
        expected_identity: None,
    }
}

/// The runtime re-registers its own origin, with its machine token, at
/// `endpoint`, as anyone holding that token could.
async fn register_origin_at(fx: &Fixture, endpoint: &str) -> anyhow::Result<()> {
    let machine = mint_scoped_token(
        &fx.state.config,
        ScopedTokenRequest {
            audience: fx.project_id.to_string(),
            subject: fx.owner_user_id.to_string(),
            project_id: fx.project_id.to_string(),
            origin_id: None,
            runtime_id: Some(fx.runtime_id.to_string()),
            protocol: None,
            scopes: vec!["origin.register".to_string()],
            lease_id: Some(fx.runtime_lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|(_, body)| anyhow::anyhow!("mint machine token: {}", body.0.message))?
    .token;
    let (status, body) = send(
        &fx.state,
        Request::builder()
            .method("POST")
            .uri("/origin/register")
            .header("authorization", format!("Bearer {machine}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "projectId": fx.project_id,
                    "originId": fx.origin_id,
                    "mode": "hosted",
                    "endpoint": endpoint,
                })
                .to_string(),
            ))?,
    )
    .await;
    anyhow::ensure!(status == StatusCode::OK, "register at {endpoint}: {body}");
    Ok(())
}

/// A hosted runtime registers its origin at a public tunnel host. Its
/// controller stop still ends with the working folder's save: the
/// credential goes to the address the runtime's provider gives for that
/// generation on its node, never to the tunnel.
#[tokio::test]
async fn a_hosted_origin_behind_a_public_tunnel_still_gets_its_final_save() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush tunnel test").await?;
    for case in ["owner_grant", "lease_holder"] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({
                    "unpushedRefs": 0,
                    "workingState": {
                        "unsaved": 1,
                        "localOnly": 0,
                        "persistedAt": "2026-10-07T13:11:07Z",
                        "durable": true,
                        "changed": false
                    }
                }),
            )
            .await?;
            register_origin_at(
                &fx,
                "https://0123456789abcdef0123456789abcdef.rt.instafy.dev",
            )
            .await?;
            if case == "lease_holder" {
                fx.hold_owner_lease().await?;
            }

            let stopped = super::super::stop::stop_runtime_safely(
                &fx.state,
                &fx.runtime_id,
                idle_reaper_stop(),
            )
            .await
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
            assert!(stopped.outcome.status_changed, "{case}");
            assert_eq!(
                stopped.flush.status, "flushed",
                "{case}: {:?}",
                stopped.flush
            );
            assert_eq!(
                stopped
                    .flush
                    .working_state
                    .as_ref()
                    .map(|state| state.durable),
                Some(true),
                "{case}"
            );
            assert_eq!(fx.order(), vec!["flush", "release"], "{case}");
            let calls = fx.flush_calls();
            assert_eq!(calls.len(), 1, "{case}: {calls:?}");
            assert_eq!(
                calls[0].body,
                json!({ "turnActive": false, "workingState": true }),
                "{case}"
            );
            assert_eq!(calls[0].git_write, StatusCode::OK, "{case}");
            // The provider was asked about exactly this generation.
            assert_eq!(
                fx.origin_asks.lock().unwrap().clone(),
                vec![json!({
                    "project_id": fx.project_id,
                    "runtime_id": fx.runtime_id,
                    "lease_id": fx.runtime_lease_id,
                })],
                "{case}"
            );
            let events = fx.flush_events().await?;
            assert_eq!(events.len(), 1, "{case}: {events:?}");
            assert_eq!(events[0]["status"], "saved", "{case}");
            assert_eq!(events[0]["writer"], case, "{case}");
            assert_eq!(events[0]["durable"], true, "{case}");
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

/// A runtime registers its origin at a node-local address of its own
/// choosing. The controller never sends a credential there: when the
/// provider places no origin of that generation on the node, the stop mints
/// nothing, calls nothing and says why; when it does, only that address is
/// called.
#[tokio::test]
async fn a_node_local_address_the_runtime_registers_is_never_called() -> anyhow::Result<()> {
    let pool =
        crate::tests::require_origin_test_pool("pre-stop flush forged endpoint test").await?;
    let claimed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let claimed_app = axum::Router::new().fallback({
        let claimed = claimed.clone();
        move |request: Request<Body>| {
            let claimed = claimed.clone();
            async move {
                claimed.lock().unwrap().push(format!(
                    "{} {} (bearer: {})",
                    request.method(),
                    request.uri(),
                    request.headers().contains_key("authorization")
                ));
                Json(json!({ "unpushedRefs": 0 }))
            }
        }
    });
    let claimed_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let claimed_endpoint = format!("http://{}", claimed_listener.local_addr()?);
    let _claimed_server = spawn_aborting(async move {
        axum::serve(claimed_listener, claimed_app)
            .await
            .expect("serve the claimed endpoint");
    });

    for (case, attests) in [
        ("owner_grant", false),
        ("lease_holder", false),
        ("owner_grant", true),
    ] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0 }),
            )
            .await?;
            register_origin_at(&fx, &claimed_endpoint).await?;
            if !attests {
                *fx.attested.lock().unwrap() = None;
            }
            if case == "lease_holder" {
                fx.hold_owner_lease().await?;
            }

            let stopped = super::super::stop::stop_runtime_safely(
                &fx.state,
                &fx.runtime_id,
                idle_reaper_stop(),
            )
            .await
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
            assert!(stopped.outcome.status_changed, "{case}");
            assert!(
                claimed.lock().unwrap().is_empty(),
                "{case}: the registered endpoint was called: {:?}",
                claimed.lock().unwrap()
            );
            assert_eq!(fx.origin_asks.lock().unwrap().len(), 1, "{case}");
            if attests {
                assert_eq!(stopped.flush.status, "flushed", "{case}");
                assert_eq!(fx.flush_calls().len(), 1, "{case}");
                return Ok(());
            }
            assert_eq!(stopped.flush.status, "no_writer", "{case}");
            assert_eq!(
                stopped.flush.reason,
                Some(super::NOT_ATTESTED_REASON),
                "{case}"
            );
            assert!(fx.flush_calls().is_empty(), "{case}");
            assert_eq!(fx.order(), vec!["release"], "{case}");
            assert_eq!(
                fx.flush_events().await?,
                vec![json!({
                    "status": "no_writer",
                    "writer": case,
                    "turnActive": false,
                    "reason": "origin_not_attested",
                })],
                "{case}"
            );
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

/// An idle stop gives way to someone who comes back while it flushes: a
/// collaborator who takes the workspace lease or pings activity keeps the
/// runtime, and the origin is told to take saves again. A drain never gives
/// way: releases do not wait on a space.
#[tokio::test]
async fn an_idle_stop_gives_way_to_someone_who_opens_the_space_during_its_flush(
) -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush reopened test").await?;
    for case in ["lease", "activity", "drain"] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let collaborator = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0, "unpushedRefNames": [] }),
            )
            .await?;
            ensure_test_user(&fx.pool, &collaborator).await?;
            fx.pool
                .get()
                .await?
                .execute(
                    "insert into project_memberships (project_id, user_id, role)
                     values ($1, $2, 'builder')",
                    &[&fx.project_id, &collaborator],
                )
                .await?;
            match case {
                "activity" => fx.during.lock().unwrap().activity = true,
                _ => *fx.collaborator.lock().unwrap() = Some(collaborator),
            }
            let options = if case == "drain" {
                super::super::stop::StopOptions {
                    source: "pool_retirement_drain",
                    reason: Some("pool_retirement".to_string()),
                    skip_if_active_jobs: false,
                    require_idle_timeout: false,
                    allow_cleanup_pending_release: false,
                    expected_identity: None,
                }
            } else {
                idle_reaper_stop()
            };
            let stopped =
                super::super::stop::stop_runtime_safely(&fx.state, &fx.runtime_id, options)
                    .await
                    .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
            assert_eq!(stopped.flush.status, "flushed", "{case}");
            let calls = fx.flush_calls();
            assert_eq!(calls.len(), 1, "{case}: {calls:?}");
            if case != "activity" {
                assert_eq!(
                    calls[0].collaborator_lease,
                    Some(true),
                    "{case}: the collaborator gets their lease during the flush"
                );
            }
            if case == "drain" {
                assert!(stopped.outcome.status_changed, "a drain never waits");
                assert_eq!(fx.order(), vec!["flush", "release"]);
                assert!(fx.resumes().is_empty());
                assert_eq!(fx.runtime_state().await?.0, "stopped");
            } else {
                assert!(!stopped.outcome.status_changed, "{case}");
                assert_eq!(
                    stopped.outcome.skip_reason.as_deref(),
                    Some("workspace_reopened"),
                    "{case}"
                );
                assert_eq!(fx.order(), vec!["flush", "resume"], "{case}");
                assert_eq!(
                    fx.resumes(),
                    vec![calls[0].bearer.clone()],
                    "{case}: lifted with the flush's own credential"
                );
                let (runtime_status, active_lease, lease_status) = fx.runtime_state().await?;
                assert_eq!(runtime_status, "ready", "{case}");
                assert_eq!(active_lease, Some(fx.runtime_lease_id), "{case}");
                assert_eq!(lease_status, "active", "{case}: never quarantined");
            }
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id, collaborator]).await?;
        result?;
    }
    Ok(())
}

/// A stop that its own checks skip after the flush ran (a job was leased
/// meanwhile) leaves the runtime running, so the origin is told to take
/// saves again: on the controller's own path and on `/runtime/stop`.
#[tokio::test]
async fn a_stop_skipped_after_its_flush_lifts_the_origins_save_fence() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush resume test").await?;
    for case in ["safe_stop", "runtime_stop"] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0, "unpushedRefNames": [] }),
            )
            .await?;
            fx.hold_owner_lease().await?;
            fx.during.lock().unwrap().lease_job = true;
            let (skip_reason, flush) = if case == "safe_stop" {
                let stopped = super::super::stop::stop_runtime_safely(
                    &fx.state,
                    &fx.runtime_id,
                    idle_reaper_stop(),
                )
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
                assert!(!stopped.outcome.status_changed);
                (stopped.outcome.skip_reason, stopped.flush)
            } else {
                let user_token =
                    crate::auth::issue_controller_token(&fx.state.config, &fx.owner_user_id)
                        .map_err(|(_, body)| {
                            anyhow::anyhow!("issue user token: {}", body.0.message)
                        })?
                        .token;
                let mut headers = HeaderMap::new();
                headers.insert(
                    axum::http::header::AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {user_token}"))?,
                );
                let payload: super::super::stop::RuntimeStopPayload =
                    serde_json::from_value(json!({
                        "runtime_id": fx.runtime_id,
                        "reason": "user_stop",
                        "skip_if_active_jobs": true,
                    }))?;
                let (_, Json(response)) = super::super::stop::runtime_stop(
                    State(fx.state.clone()),
                    headers,
                    axum::Json(payload),
                )
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
                assert!(!response.status_changed);
                (
                    response.skip_reason,
                    response.flush.expect("the stop reports its flush"),
                )
            };
            assert_eq!(skip_reason.as_deref(), Some("active_jobs"), "{case}");
            assert_eq!(flush.status, "flushed", "{case}");
            assert_eq!(fx.order(), vec!["flush", "resume"], "{case}");
            let calls = fx.flush_calls();
            assert_eq!(fx.resumes(), vec![calls[0].bearer.clone()], "{case}");
            assert_eq!(fx.runtime_state().await?.0, "ready", "{case}");
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

/// The idle release requeues a job whose lease ran out mid-turn and then
/// stops the runtime that held it. That turn is interrupted, whatever the
/// jobs table shows by then, so the flush sets its commits aside
/// (`turnActive`). Only the controller's own sweep saves under the owner's
/// permission; a client's idle signal saves only under a lease holder.
#[tokio::test]
async fn an_idle_release_flushes_its_requeued_turn_as_interrupted() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush idle release test").await?;
    for released_by in [
        super::super::status::IdleRelease::Sweep,
        super::super::status::IdleRelease::Requested,
    ] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({ "unpushedRefs": 0, "unpushedRefNames": [] }),
            )
            .await?;
            let job_id = Uuid::new_v4();
            fx.pool
                .get()
                .await?
                .execute(
                    "insert into agent_jobs
                        (id, project_id, status, payload, leased_by_runtime_id,
                         leased_at, lease_expires_at)
                     values ($1, $2, 'leased', '{}'::jsonb, $3,
                             now() - interval '10 minutes', now() - interval '1 minute')",
                    &[&job_id, &fx.project_id, &fx.runtime_id],
                )
                .await?;
            let released = super::super::status::release_leases_for_project(
                &fx.state,
                &fx.project_id,
                600,
                "pre_stop_flush_test",
                released_by,
            )
            .await?;
            assert_eq!(released, 1, "{released_by:?}");
            assert_eq!(fx.runtime_state().await?.0, "stopped", "{released_by:?}");
            let calls = fx.flush_calls();
            match released_by {
                super::super::status::IdleRelease::Sweep => {
                    assert_eq!(calls.len(), 1, "{calls:?}");
                    assert_eq!(
                        calls[0].body,
                        json!({ "turnActive": true, "workingState": true })
                    );
                    assert_eq!(
                        calls[0].job_statuses,
                        vec!["queued".to_string()],
                        "the job was already requeued"
                    );
                    assert_eq!(fx.flush_events().await?[0]["writer"], "owner_grant");
                }
                super::super::status::IdleRelease::Requested => {
                    assert!(calls.is_empty(), "{calls:?}");
                    assert_eq!(
                        fx.flush_events().await?,
                        vec![
                            json!({ "status": "no_writer", "writer": "none", "turnActive": true })
                        ]
                    );
                }
            }
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

/// With rolling saves on, a stop asks the origin to end with the working
/// folder's own save and records what that save left (`durable`,
/// `persistedAt`) on the event and the stop's answer. Switched off, the
/// flush body is exactly what it always was.
#[tokio::test]
async fn the_switch_decides_whether_a_stop_asks_for_the_working_folders_save() -> anyhow::Result<()>
{
    let pool = crate::tests::require_origin_test_pool("pre-stop working save test").await?;
    for saves in [true, false] {
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let fixture = SharedDbFixture {
            projects: vec![project_id],
            ..Default::default()
        };
        let result = with_shared_db_fixture(fixture, async {
            let fx = Fixture::new_with(
                pool.clone(),
                project_id,
                owner_user_id,
                json!({
                    "recoveryRefs": [],
                    "unpushedRefs": 0,
                    "unpushedRefNames": [],
                    "parkedCommits": 0,
                    "workingState": {
                        "unsaved": 1,
                        "localOnly": 0,
                        "persistedAt": "2026-10-07T12:00:00Z",
                        "durable": true,
                        "changed": false
                    },
                }),
                |config| config.working_state_saves = saves,
            )
            .await?;
            fx.insert_leased_job().await?;
            fx.hold_owner_lease().await?;
            let stopped = super::super::stop::stop_runtime_safely(
                &fx.state,
                &fx.runtime_id,
                super::super::stop::StopOptions {
                    source: "pre_stop_flush_test",
                    reason: Some("credits_exhausted".to_string()),
                    skip_if_active_jobs: false,
                    require_idle_timeout: false,
                    allow_cleanup_pending_release: false,
                    expected_identity: None,
                },
            )
            .await
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
            let calls = fx.flush_calls();
            assert_eq!(calls.len(), 1, "{calls:?}");
            let events = fx.flush_events().await?;
            assert_eq!(events.len(), 1, "{events:?}");
            if saves {
                assert_eq!(
                    calls[0].body,
                    json!({ "turnActive": true, "workingState": true })
                );
                assert_eq!(events[0]["durable"], true, "{events:?}");
                assert_eq!(events[0]["persistedAt"], "2026-10-07T12:00:00Z");
                let working = stopped.flush.working_state.clone().expect("workingState");
                assert!(working.durable);
                let answer = serde_json::to_value(&stopped.flush)?;
                assert_eq!(answer["workingState"]["durable"], true, "{answer}");
            } else {
                assert_eq!(calls[0].body, json!({ "turnActive": true }));
            }
            Ok(())
        })
        .await;
        delete_users(&[owner_user_id]).await?;
        result?;
    }
    Ok(())
}

/// The internal workspace bearer of a job leased by `fx`'s runtime.
fn job_workspace_bearer(fx: &Fixture, run_id: Uuid, runtime_lease_id: Uuid) -> String {
    mint_scoped_token(
        &fx.state.config,
        ScopedTokenRequest {
            audience: fx.runtime_id.to_string(),
            subject: fx.owner_user_id.to_string(),
            project_id: fx.project_id.to_string(),
            origin_id: None,
            runtime_id: Some(fx.runtime_id.to_string()),
            protocol: None,
            scopes: vec![
                crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE.to_string(),
                crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE.to_string(),
            ],
            lease_id: Some(runtime_lease_id.to_string()),
            run_id: Some(run_id.to_string()),
            prefer_runtime: None,
            ttl_seconds: Some(600),
        },
    )
    .expect("job workspace token")
    .token
}

fn persist_grant_request(project_id: Uuid, bearer: &str, job_id: Option<Uuid>) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/access_token")
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "projectId": project_id,
                "protocol": "http",
                "scopes": ["workspace.persist"],
                "jobId": job_id,
            })
            .to_string(),
        ))
        .expect("persist grant request")
}

/// A running write job's rolling save gets a grant for its runtime's own
/// online origin, which mints git.write only while the job and its runtime
/// generation hold. A read-only job, a job long finished, another
/// generation, a user who may no longer write and the switch turned off are
/// refused.
#[tokio::test]
async fn a_rolling_save_grant_holds_only_while_its_write_job_does() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("rolling save grant test").await?;
    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let fx = Fixture::new(pool.clone(), project_id, owner_user_id, json!({})).await?;
        ensure_test_user(&fx.pool, &stranger).await?;
        let insert_job = |payload: JsonValue, status: &'static str, seconds_ago: f64| {
            let pool = fx.pool.clone();
            let project_id = fx.project_id;
            let runtime_id = fx.runtime_id;
            async move {
                let (job_id, run_id) = (Uuid::new_v4(), Uuid::new_v4());
                let connection = pool.get().await?;
                connection
                    .execute(
                        "insert into runs (id, project_id, run_type, status)
                         values ($1, $2, 'prompt', 'in_progress')",
                        &[&run_id, &project_id],
                    )
                    .await?;
                connection
                    .execute(
                        "insert into agent_jobs
                            (id, project_id, run_id, status, payload, leased_by_runtime_id,
                             leased_at, lease_expires_at, completed_at)
                         values ($1, $2, $3, $4, $5, $6, now() - interval '5 minutes',
                                 now() + interval '5 minutes',
                                 case when $4 = 'leased' then null
                                      else now() - make_interval(secs => $7::double precision)
                                 end)",
                        &[
                            &job_id,
                            &project_id,
                            &run_id,
                            &status,
                            &payload,
                            &runtime_id,
                            &seconds_ago,
                        ],
                    )
                    .await?;
                Ok::<_, anyhow::Error>((job_id, run_id))
            }
        };
        let write = json!({ "user_id": owner_user_id, "writeIntent": true, "metadata": {} });
        let (job_id, run_id) = insert_job(write.clone(), "leased", 0.0).await?;
        let bearer = job_workspace_bearer(&fx, run_id, fx.runtime_lease_id);

        let (status, body) = send(
            &fx.state,
            persist_grant_request(fx.project_id, &bearer, Some(job_id)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["originId"], json!(fx.origin_id));
        let grant = body["token"].as_str().expect("a grant").to_string();
        let claims = decode_scoped_token(&fx.state.config, &grant, "rolling save grant")
            .map_err(|(_, body)| anyhow::anyhow!("decode grant: {}", body.0.message))?;
        assert_eq!(claims.aud, fx.origin_id.to_string());
        assert_eq!(claims.scopes, vec!["workspace.persist".to_string()]);
        assert_eq!(claims.origin_id, Some(fx.origin_id.to_string()));
        assert_eq!(claims.runtime_id, Some(fx.runtime_id.to_string()));
        assert_eq!(claims.lease_id, Some(fx.runtime_lease_id.to_string()));
        assert_eq!(claims.run_id, Some(run_id.to_string()));
        assert!(claims.exp - claims.iat <= 60, "{claims:?}");
        let exchange = |bearer: String| {
            let state = fx.state.clone();
            let project_id = fx.project_id;
            async move { send(&state, git_token_request(project_id, &bearer)).await }
        };
        assert_eq!(exchange(grant.clone()).await.0, StatusCode::OK);
        // It reads no workspace lease and opens nothing else here.
        let (lease_status, _) = send(
            &fx.state,
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{}/lease", fx.project_id))
                .header("authorization", format!("Bearer {grant}"))
                .body(Body::empty())?,
        )
        .await;
        assert_ne!(lease_status, StatusCode::OK);
        // The grant itself mints no other grant.
        let (status, _) = send(&fx.state, persist_grant_request(fx.project_id, &grant, None)).await;
        assert_ne!(status, StatusCode::OK);

        // Another runtime generation's token.
        let stale = job_workspace_bearer(&fx, run_id, Uuid::new_v4());
        let (status, _) = send(&fx.state, persist_grant_request(fx.project_id, &stale, None)).await;
        assert_ne!(status, StatusCode::OK);

        // A read-only job.
        let read_only = json!({
            "user_id": owner_user_id,
            "writeIntent": true,
            "metadata": { "writeScope": "read_only" },
        });
        let (_, read_only_run) = insert_job(read_only, "leased", 0.0).await?;
        let read_only_bearer = job_workspace_bearer(&fx, read_only_run, fx.runtime_lease_id);
        let (status, _) = send(
            &fx.state,
            persist_grant_request(fx.project_id, &read_only_bearer, None),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // Cancelled a moment ago (the turn-end save of a stopped turn):
        // granted. Cancelled long ago, or completed: refused.
        let (_, cancelled_run) = insert_job(write.clone(), "canceled", 10.0).await?;
        let cancelled = job_workspace_bearer(&fx, cancelled_run, fx.runtime_lease_id);
        let (status, body) = send(
            &fx.state,
            persist_grant_request(fx.project_id, &cancelled, None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        for (status_name, seconds_ago) in [("canceled", 120.0), ("completed", 1.0)] {
            let (_, run) = insert_job(write.clone(), status_name, seconds_ago).await?;
            let bearer = job_workspace_bearer(&fx, run, fx.runtime_lease_id);
            let (status, _) =
                send(&fx.state, persist_grant_request(fx.project_id, &bearer, None)).await;
            assert_ne!(status, StatusCode::OK, "{status_name} {seconds_ago}s ago");
        }

        // The exchange checks the job again: once it is done, the grant is
        // dead.
        let connection = fx.pool.get().await?;
        connection
            .execute(
                "update agent_jobs set status = 'completed', completed_at = now() - interval '5 minutes' where id = $1",
                &[&job_id],
            )
            .await?;
        assert_ne!(exchange(grant.clone()).await.0, StatusCode::OK);
        connection
            .execute(
                "update agent_jobs set status = 'leased', completed_at = null where id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(exchange(grant.clone()).await.0, StatusCode::OK);

        // The user may no longer write.
        connection
            .execute(
                "update projects set owner_user_id = $2 where id = $1",
                &[&fx.project_id, &stranger],
            )
            .await?;
        let (status, _) = send(&fx.state, persist_grant_request(fx.project_id, &bearer, None)).await;
        assert_ne!(status, StatusCode::OK);
        assert_ne!(exchange(grant.clone()).await.0, StatusCode::OK);
        connection
            .execute(
                "update projects set owner_user_id = $2 where id = $1",
                &[&fx.project_id, &fx.owner_user_id],
            )
            .await?;

        // The generation was quarantined by its stop.
        connection
            .execute(
                "update runtime_leases set status = 'cleanup_pending' where id = $1",
                &[&fx.runtime_lease_id],
            )
            .await?;
        assert_ne!(exchange(grant.clone()).await.0, StatusCode::OK);
        connection
            .execute(
                "update runtime_leases set status = 'active' where id = $1",
                &[&fx.runtime_lease_id],
            )
            .await?;
        drop(connection);

        // Switched off: refused with a fixed code, minting and exchanging.
        let mut off = fx.state.config.clone();
        off.working_state_saves = false;
        let off_state = build_test_state(fx.pool.clone(), off);
        let (status, body) =
            send(&off_state, persist_grant_request(fx.project_id, &bearer, None)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["code"], "rolling_saves_off", "{body}");
        let (status, body) = send(&off_state, git_token_request(fx.project_id, &grant)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["code"], "rolling_saves_off", "{body}");
        fx.pool
            .get()
            .await?
            .execute("delete from runs where project_id = $1", &[&fx.project_id])
            .await?;
        Ok(())
    })
    .await;
    delete_users(&[owner_user_id, stranger]).await?;
    result
}
