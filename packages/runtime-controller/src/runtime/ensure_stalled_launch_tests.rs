use super::*;

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::Request;
use tokio::sync::Mutex;
use tower::ServiceExt;

const DISPLAY_NAME: &str = "Stalled launch runtime";
const STALLED_LAUNCH_AGE_SECONDS: i64 = 6 * 60;
const YOUNG_LAUNCH_AGE_SECONDS: i64 = 2 * 60;

#[test]
fn is_stalled_launch_needs_a_never_seen_launch_older_than_the_bound() {
    let bound = Some(STALLED_LAUNCH_REPLACE_AFTER_SECONDS);
    assert!(is_stalled_launch(
        "requested",
        None,
        Some("launching"),
        false,
        bound
    ));
    assert!(is_stalled_launch(
        "requested",
        None,
        Some("pending"),
        false,
        Some(STALLED_LAUNCH_AGE_SECONDS)
    ));
    assert!(!is_stalled_launch(
        "requested",
        None,
        Some("launching"),
        false,
        Some(STALLED_LAUNCH_REPLACE_AFTER_SECONDS - 1)
    ));
    // A runtime that was seen, or is no longer only requested, came up.
    assert!(!is_stalled_launch(
        "requested",
        Some(Utc::now()),
        Some("launching"),
        false,
        bound
    ));
    assert!(!is_stalled_launch(
        "ready",
        None,
        Some("launching"),
        false,
        bound
    ));
    // A lease quarantined for cleanup, active, released or missing is not a
    // launch in flight.
    for lease_status in [Some("cleanup_pending"), Some("active"), None] {
        assert!(!is_stalled_launch(
            "requested",
            None,
            lease_status,
            false,
            bound
        ));
    }
    assert!(!is_stalled_launch(
        "requested",
        None,
        Some("launching"),
        true,
        bound
    ));
    assert!(!is_stalled_launch(
        "requested",
        None,
        Some("launching"),
        false,
        None
    ));
}

/// A space whose hosted runtime was requested `launch_age_seconds` ago and
/// is still `requested` with a `launching` lease, against a test provider
/// that records every launch and release.
struct StalledLaunchFixture {
    pool: crate::config::PgPool,
    state: AppState,
    org_id: Uuid,
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    provider_id: String,
    provider_events: Arc<Mutex<Vec<&'static str>>>,
    _provider_handle: tokio::task::JoinHandle<()>,
}

impl StalledLaunchFixture {
    fn shared_db_fixture(&self) -> crate::tests::SharedDbFixture {
        crate::tests::SharedDbFixture {
            organizations: vec![self.org_id],
            projects: vec![self.project_id],
        }
    }

    /// `POST /runtime/ensure` as the Studio sends it. `replace_stalled_launch`
    /// `None` leaves the field out, as a client from before it does.
    async fn ensure_over_http(
        &self,
        with_runtime_id: bool,
        replace_stalled_launch: Option<bool>,
    ) -> anyhow::Result<RuntimeEnsureReply> {
        let mut body = json!({
            "project_id": self.project_id.to_string(),
            "provider": self.provider_id,
            "displayName": DISPLAY_NAME,
            "scope": "exclusive",
        });
        if with_runtime_id {
            body["runtimeId"] = json!(self.runtime_id.to_string());
        }
        if let Some(replace) = replace_stalled_launch {
            body["replaceStalledLaunch"] = json!(replace);
        }
        let response = crate::runtime::router()
            .with_state(self.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/ensure")
                    .header("authorization", "Bearer service-role-token")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        let status = response.status();
        let body: JsonValue =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        anyhow::ensure!(status == StatusCode::OK, "ensure answered {status}: {body}");
        let lease_id = body["leaseId"]
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| anyhow::anyhow!("ensure answered without a lease: {body}"))?;
        let runtime_id = body["runtime_id"]
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| anyhow::anyhow!("ensure answered without a runtime: {body}"))?;
        Ok(RuntimeEnsureReply {
            runtime_id,
            lease_id,
        })
    }

    /// This runtime's entry in the space's runtime status, as JSON.
    async fn status_entry(&self) -> anyhow::Result<JsonValue> {
        let mut connection = self.pool.get().await?;
        let transaction = connection.transaction().await?;
        let response = crate::runtime::load_runtime_status_response(
            &self.state,
            &transaction,
            &self.project_id,
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        transaction.rollback().await?;
        let response = serde_json::to_value(&response)?;
        response["runtimes"]
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry["runtimeId"] == json!(self.runtime_id.to_string()))
            })
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("runtime missing from status: {response}"))
    }

    async fn provider_events(&self) -> Vec<&'static str> {
        self.provider_events.lock().await.clone()
    }

    async fn lease_count(&self) -> anyhow::Result<i64> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select count(*)::bigint from runtime_leases where runtime_id = $1",
                &[&self.runtime_id],
            )
            .await?
            .get(0))
    }

    /// The original launch is still the runtime's only, unreleased lease and
    /// the provider was never called.
    async fn assert_launch_reused(&self, reply: &RuntimeEnsureReply) -> anyhow::Result<()> {
        assert_eq!(reply.runtime_id, self.runtime_id);
        assert_eq!(reply.lease_id, self.lease_id, "the launch should be reused");
        assert_eq!(self.lease_count().await?, 1, "no new lease should exist");
        assert!(
            self.provider_events().await.is_empty(),
            "reusing a launch must not call the provider"
        );
        let lease_status: String = self
            .pool
            .get()
            .await?
            .query_one(
                "select status from runtime_leases where id = $1",
                &[&self.lease_id],
            )
            .await?
            .get(0);
        assert_eq!(lease_status, "launching");
        Ok(())
    }

    /// The original launch was released through the provider before a new
    /// lease on the same runtime was launched.
    async fn assert_launch_replaced(&self, reply: &RuntimeEnsureReply) -> anyhow::Result<()> {
        assert_eq!(reply.runtime_id, self.runtime_id);
        assert_ne!(reply.lease_id, self.lease_id, "a new lease should launch");
        assert_eq!(
            self.provider_events().await,
            vec!["release", "launch"],
            "the stalled launch should be released before the new one launches"
        );

        let connection = self.pool.get().await?;
        let runtime_row = connection
            .query_one(
                "select status, active_lease_id, last_seen_at from runtimes where id = $1",
                &[&self.runtime_id],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "requested");
        assert_eq!(
            runtime_row.get::<_, Option<Uuid>>("active_lease_id"),
            Some(reply.lease_id)
        );
        assert!(runtime_row
            .get::<_, Option<chrono::DateTime<Utc>>>("last_seen_at")
            .is_none());

        let old_lease = connection
            .query_one(
                "select status, released_at is not null as released
                 from runtime_leases where id = $1",
                &[&self.lease_id],
            )
            .await?;
        assert_eq!(old_lease.get::<_, String>("status"), "released");
        assert!(old_lease.get::<_, bool>("released"));
        let new_lease = connection
            .query_one(
                "select status, released_at is null as live,
                        requested_at > now() - interval '1 minute' as fresh
                 from runtime_leases where id = $1",
                &[&reply.lease_id],
            )
            .await?;
        assert_eq!(new_lease.get::<_, String>("status"), "launching");
        assert!(new_lease.get::<_, bool>("live"));
        assert!(
            new_lease.get::<_, bool>("fresh"),
            "the new lease starts its own launch clock"
        );

        let acknowledged: i64 = connection
            .query_one(
                "select count(*)::bigint from runtime_events
                 where runtime_id = $1
                   and kind = 'provider_release_acknowledged'
                   and data ->> 'runtimeLeaseId' = $2",
                &[&self.runtime_id, &self.lease_id.to_string()],
            )
            .await?
            .get(0);
        assert_eq!(acknowledged, 1);
        let stop_reason: Option<String> = connection
            .query_one(
                "select data ->> 'reason' from runtime_events
                 where runtime_id = $1 and kind = 'stopped'
                 order by id desc
                 limit 1",
                &[&self.runtime_id],
            )
            .await?
            .get(0);
        assert_eq!(stop_reason.as_deref(), Some("launch_retry"));
        Ok(())
    }
}

struct RuntimeEnsureReply {
    runtime_id: Uuid,
    lease_id: Uuid,
}

/// `seen_seconds_ago` sets the runtime's `last_seen_at`; `None` leaves it
/// empty, as for a runtime that never registered.
async fn setup(
    test_name: &'static str,
    launch_age_seconds: i64,
    seen_seconds_ago: Option<i64>,
) -> anyhow::Result<StalledLaunchFixture> {
    let pool = crate::tests::require_origin_test_pool(test_name).await?;

    let provider_events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let provider_app = axum::Router::new()
        .route(
            "/runtime/ensure",
            axum::routing::post({
                let provider_events = provider_events.clone();
                move || {
                    let provider_events = provider_events.clone();
                    async move {
                        provider_events.lock().await.push("launch");
                        Json(json!({ "message": "runtime ensured" }))
                    }
                }
            }),
        )
        .route(
            "/runtime/release",
            axum::routing::post({
                let provider_events = provider_events.clone();
                move || {
                    let provider_events = provider_events.clone();
                    async move {
                        provider_events.lock().await.push("release");
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
            .expect("serve stalled launch test provider");
    });

    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    // Unique per test, so a runtime chosen by provider and name is this one.
    let provider_id = format!("stalled-launch-test-{}", Uuid::new_v4().simple());

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("stalled-launch-{org_id}"),
                    &"Stalled launch test",
                ],
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
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds, display_name,
                     last_seen_at)
                 values ($1, $2, $3, 'requested', 600, $4,
                         now() - make_interval(secs => $5::double precision))",
                &[
                    &runtime_id,
                    &project_id,
                    &provider_id,
                    &DISPLAY_NAME,
                    &seen_seconds_ago.map(|seconds| seconds as f64),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at)
                 values ($1, $2, $3, 'launching',
                         now() - make_interval(secs => $4::double precision))",
                &[
                    &lease_id,
                    &project_id,
                    &runtime_id,
                    &(launch_age_seconds as f64),
                ],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
    }

    let mut config = crate::tests::build_app_config(
        crate::tests::test_origin_private_key(),
        crate::tests::test_origin_public_key(),
        test_name,
    );
    config.runtime_providers = vec![crate::config::RuntimeProviderConfig {
        id: provider_id.clone(),
        display_name: "Stalled launch test".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    }];
    let state = crate::tests::build_test_state(pool.clone(), config);

    Ok(StalledLaunchFixture {
        pool,
        state,
        org_id,
        project_id,
        runtime_id,
        lease_id,
        provider_id,
        provider_events,
        _provider_handle: provider_handle,
    })
}

/// A client from before `replaceStalledLaunch` keeps today's behaviour: the
/// launch it is waiting on is reused, however long it has been coming up.
#[tokio::test]
async fn ensure_without_the_flag_reuses_a_launch_that_never_came_up() -> anyhow::Result<()> {
    let fixture = setup("stalled-launch-no-flag", STALLED_LAUNCH_AGE_SECONDS, None).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let reply = fixture.ensure_over_http(true, None).await?;
        fixture.assert_launch_reused(&reply).await?;
        let reply = fixture.ensure_over_http(true, Some(false)).await?;
        fixture.assert_launch_reused(&reply).await
    })
    .await
}

/// Machines Start: a retry naming the runtime replaces its stalled launch.
#[tokio::test]
async fn explicit_retry_replaces_a_launch_that_never_came_up() -> anyhow::Result<()> {
    let fixture = setup("stalled-launch-replace", STALLED_LAUNCH_AGE_SECONDS, None).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let reply = fixture.ensure_over_http(true, Some(true)).await?;
        fixture.assert_launch_replaced(&reply).await?;

        // The new launch is younger than the bound, so another retry right
        // away reuses it rather than replacing it again.
        let again = fixture.ensure_over_http(true, Some(true)).await?;
        assert_eq!(again.lease_id, reply.lease_id);
        assert_eq!(fixture.provider_events().await, vec!["release", "launch"]);
        Ok(())
    })
    .await
}

/// The chat's retry finds the space's runtime by provider and name.
#[tokio::test]
async fn explicit_retry_without_a_runtime_id_replaces_the_stalled_launch() -> anyhow::Result<()> {
    let fixture = setup(
        "stalled-launch-replace-by-name",
        STALLED_LAUNCH_AGE_SECONDS,
        None,
    )
    .await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let reply = fixture.ensure_over_http(false, Some(true)).await?;
        fixture.assert_launch_replaced(&reply).await
    })
    .await
}

#[tokio::test]
async fn explicit_retry_reuses_a_launch_younger_than_the_bound() -> anyhow::Result<()> {
    let fixture = setup("stalled-launch-young", YOUNG_LAUNCH_AGE_SECONDS, None).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let reply = fixture.ensure_over_http(true, Some(true)).await?;
        fixture.assert_launch_reused(&reply).await
    })
    .await
}

/// A runtime that has reported in is coming up, however old its lease.
#[tokio::test]
async fn explicit_retry_keeps_a_launch_that_has_been_seen() -> anyhow::Result<()> {
    let fixture = setup("stalled-launch-seen", STALLED_LAUNCH_AGE_SECONDS, Some(10)).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let reply = fixture.ensure_over_http(true, Some(true)).await?;
        fixture.assert_launch_reused(&reply).await
    })
    .await
}

/// A launch that came up and leased a job since the retry was offered wins.
#[tokio::test]
async fn explicit_retry_keeps_a_launch_that_leased_a_job() -> anyhow::Result<()> {
    let fixture = setup(
        "stalled-launch-leased-job",
        STALLED_LAUNCH_AGE_SECONDS,
        None,
    )
    .await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        fixture
            .pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs
                    (project_id, status, leased_at, lease_expires_at, leased_by_runtime_id)
                 values ($1, 'leased', now(), now() + interval '5 minutes', $2)",
                &[&fixture.project_id, &fixture.runtime_id],
            )
            .await?;
        let reply = fixture.ensure_over_http(true, Some(true)).await?;
        fixture.assert_launch_reused(&reply).await
    })
    .await
}

/// The status entry says when the active launch was requested, so a client
/// can tell how long it has been coming up; without an active lease it says
/// nothing.
#[tokio::test]
async fn runtime_status_reports_when_the_active_launch_was_requested() -> anyhow::Result<()> {
    let fixture = setup("stalled-launch-status", STALLED_LAUNCH_AGE_SECONDS, None).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let requested_at: chrono::DateTime<Utc> = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select requested_at from runtime_leases where id = $1",
                &[&fixture.lease_id],
            )
            .await?
            .get(0);
        let entry = fixture.status_entry().await?;
        assert_eq!(entry["launchRequestedAt"], json!(requested_at.to_rfc3339()));
        assert_eq!(entry["lastSeenAt"], JsonValue::Null);

        {
            let mut connection = fixture.pool.get().await?;
            let transaction = connection.transaction().await?;
            mark_runtime_lease_released(
                &transaction,
                &fixture.runtime_id,
                &fixture.lease_id,
                false,
            )
            .await
            .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
            transaction
                .execute(
                    "update runtimes set status = 'stopped' where id = $1",
                    &[&fixture.runtime_id],
                )
                .await?;
            transaction.commit().await?;
        }
        let entry = fixture.status_entry().await?;
        assert!(
            entry.get("launchRequestedAt").is_none(),
            "a runtime without an active lease has no launch time: {entry}"
        );
        Ok(())
    })
    .await
}
