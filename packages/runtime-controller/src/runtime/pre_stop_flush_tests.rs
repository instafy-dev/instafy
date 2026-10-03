//! Database-backed tests of the pre-stop flush: a real controller state on
//! the shared test database, a stand-in runtime origin and a stand-in
//! provider. The stand-in origin does what the real one does with the
//! controller's token: it checks the workspace lease and mints `git.write`
//! through the controller's own routes. It can also take a collaborator's
//! workspace lease while the flush runs, as someone opening the space at
//! that moment would.

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
        let order = Arc::new(Mutex::new(Vec::new()));
        let provider_app = axum::Router::new().route(
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
        let origin_app = axum::Router::new()
            .route("/git/flush", axum::routing::post(handle_flush))
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
            });
        let origin_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let origin_endpoint = format!("http://{}", origin_listener.local_addr()?);
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
            _provider: provider,
            _origin: origin,
        })
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
        assert_eq!(call.body, json!({ "turnActive": true }));
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
        assert_eq!(call.body, json!({ "turnActive": false }));
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
        // Point the origin at a path without the route.
        fx.pool
            .get()
            .await?
            .execute(
                "update workspace_origins set endpoint = endpoint || '/legacy' where id = $1",
                &[&fx.origin_id],
            )
            .await?;
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
        assert!(stopped.flush.error.is_some());
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
/// for git.write; it opens nothing else, takes no workspace lease, and a
/// collaborator who opens the space during the flush gets their lease.
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
            } else {
                *fx.collaborator.lock().unwrap() = Some(collaborator);
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
            assert!(claims.exp - claims.iat <= 120, "{claims:?}");
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
            assert!(
                git_claims.exp <= claims.exp,
                "the git token outlives the permission"
            );
            assert_eq!(call.machine_git_write, StatusCode::FORBIDDEN, "{case}");
            if case == "no_lease" {
                assert_eq!(
                    call.collaborator_lease,
                    Some(true),
                    "someone opening the space during the flush gets their lease"
                );
            }

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

/// A stop a user or a runtime asked for never uses the owner's permission:
/// with nobody holding a workspace lease it mints nothing and does not call
/// the origin, and says so (`no_writer`). A space without an owner gets
/// nothing on the controller's own path either.
#[tokio::test]
async fn requested_stops_and_ownerless_spaces_mint_nothing() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("pre-stop flush no-writer test").await?;
    for case in ["user_stop", "ownerless"] {
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
            let flush = if case == "user_stop" {
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
                    }))?;
                let (status, Json(response)) = super::super::stop::runtime_stop(
                    State(fx.state.clone()),
                    headers,
                    axum::Json(payload),
                )
                .await
                .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
                assert_eq!(status, StatusCode::OK);
                response.flush.expect("the stop reports its flush")
            } else {
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
            };
            assert_eq!(flush.status, "no_writer", "{case}");
            assert_eq!(flush.unpushed_refs, None, "{case}: unknown");
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
            assert_eq!(fx.runtime_state().await?.0, "stopped", "{case}");
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
                json!({ "turnActive": expected }),
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
