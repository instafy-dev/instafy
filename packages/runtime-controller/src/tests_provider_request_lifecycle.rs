#![cfg(test)]

// Database-backed coverage for the provider request lifecycle: held-open
// dispatches against a small pool, claim windows, late completions, device
// targeting, and cancellation by the end of the request's job.
// Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::Router;
use futures_util::future::join_all;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::config::PgPool;
use crate::state::ControllerEvent;
use crate::tests::{
    build_app_config, build_test_state, call_router, eventually,
    require_origin_test_pool_with_max_size, sql, sql_one, test_origin_private_key,
    test_origin_public_key,
};
use crate::tests_provider_space::{
    canceled, insert_request, listed_ids, person, with_space, NewRequest, DEVICE_ID,
    OTHER_DEVICE_ID, PROVIDER_ID, SERVICE_ROLE,
};
use crate::AppState;

#[derive(Clone)]
struct Fixture {
    pool: PgPool,
    state: AppState,
    app: Router,
    project_id: Uuid,
}

impl Fixture {
    async fn new(pool_size: u32, key_id: &str) -> anyhow::Result<Self> {
        let pool = require_origin_test_pool_with_max_size(key_id, pool_size).await?;
        let project_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                    &[&project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into project_integrations (id, project_id, provider, status, connection_type)
                     values ($1, $2, $3, 'attached', 'device')",
                    &[&Uuid::new_v4(), &project_id, &PROVIDER_ID],
                )
                .await?;
        }
        let state = build_test_state(
            pool.clone(),
            build_app_config(test_origin_private_key(), test_origin_public_key(), key_id),
        );
        let app = crate::provider_requests::router().with_state(state.clone());
        Ok(Self {
            pool,
            state,
            app,
            project_id,
        })
    }

    /// The listing, or only what `device_id` may act on.
    async fn list(
        &self,
        statuses: &[&str],
        device_id: Option<&str>,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let device = device_id
            .map(|id| format!("&deviceId={id}"))
            .unwrap_or_default();
        call(
            &self.app,
            "GET",
            format!(
                "/projects/{}/provider-requests?providerId={PROVIDER_ID}&statuses={}{device}&limit=20",
                self.project_id,
                statuses.join(",")
            ),
            None,
        )
        .await
    }

    async fn claim(
        &self,
        request_id: Uuid,
        device_id: &str,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        call(
            &self.app,
            "POST",
            format!(
                "/projects/{}/provider-requests/{request_id}/claim",
                self.project_id
            ),
            Some(json!({ "providerId": PROVIDER_ID, "deviceId": device_id, "deviceLabel": "Test Device" })),
        )
        .await
    }

    async fn complete(
        &self,
        request_id: Uuid,
        device_id: &str,
        response: JsonValue,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        call(
            &self.app,
            "POST",
            format!(
                "/projects/{}/provider-requests/{request_id}/complete",
                self.project_id
            ),
            Some(json!({ "providerId": PROVIDER_ID, "deviceId": device_id, "response": response })),
        )
        .await
    }

    /// A row as an earlier dispatch left it. Offsets are seconds from now.
    async fn insert_request(
        &self,
        status: &str,
        created_in: i64,
        expires_in: i64,
        claimed_by: Option<&str>,
        error: Option<&str>,
    ) -> anyhow::Result<Uuid> {
        let request = NewRequest {
            status,
            claimed_by,
            created_in,
            expires_in,
            error,
            ..NewRequest::default()
        };
        insert_request(&self.pool, self.project_id, request).await
    }

    async fn stored(&self, request_id: Uuid) -> anyhow::Result<(String, Option<String>)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, error from project_provider_requests where id = $1",
                &[&request_id],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    /// Whether the device's answer came after the request's window closed.
    async fn answered_late(&self, request_id: Uuid) -> anyhow::Result<bool> {
        let late = "select completed_at > expires_at from project_provider_requests where id = $1";
        sql_one(&self.pool, late, &[&request_id]).await
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        connection
            .execute(
                "delete from project_provider_requests where project_id = $1",
                &[&self.project_id],
            )
            .await?;
        connection
            .execute(
                "delete from project_integrations where project_id = $1",
                &[&self.project_id],
            )
            .await?;
        connection
            .execute("delete from projects where id = $1", &[&self.project_id])
            .await?;
        Ok(())
    }
}

/// A call as the service role.
async fn call(
    app: &Router,
    method: &str,
    uri: String,
    body: Option<JsonValue>,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let service_role = format!("Bearer {SERVICE_ROLE}");
    call_router(app, Some(&service_role), method, uri, body).await
}

async fn dispatch(
    app: &Router,
    project_id: Uuid,
    arguments: JsonValue,
    timeout_ms: u64,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    call(
        app,
        "POST",
        format!("/projects/{project_id}/provider-tools/call"),
        Some(json!({
            "providerId": PROVIDER_ID,
            "name": "device.echo",
            "arguments": arguments,
            "timeoutMs": timeout_ms,
        })),
    )
    .await
}

/// The `provider.request.updated` events received so far for `request_id`.
fn updates_for(
    events: &mut tokio::sync::broadcast::Receiver<ControllerEvent>,
    request_id: Uuid,
) -> Vec<ControllerEvent> {
    let mut updates = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.kind == "provider.request.updated" && event.data["requestId"] == json!(request_id)
        {
            updates.push(event);
        }
    }
    updates
}

/// The first pending request the listing offers, other than `except`, once
/// there is one.
async fn first_listed(fixture: &Fixture, except: Option<Uuid>) -> anyhow::Result<Uuid> {
    eventually("the dispatch to queue its request", || async {
        let (_, listing) = fixture.list(&["pending"], None).await?;
        Ok(listed_ids(&listing)
            .into_iter()
            .find(|id| Some(*id) != except))
    })
    .await
}

/// Five dispatches held open at once, while the device claims and completes
/// them concurrently, on a pool of four connections. A dispatch used to keep
/// two connections for its whole wait (the handler's and the waiter's), so
/// two of them starved the pool and the device's own claims with it.
#[tokio::test]
async fn held_open_dispatches_leave_the_pool_to_the_device() -> anyhow::Result<()> {
    let fixture = Fixture::new(4, "provider-request-pool").await?;
    let app = fixture.app.clone();
    let project_id = fixture.project_id;

    let dispatches = (0..5i64)
        .map(|n| {
            let app = app.clone();
            tokio::spawn(async move { dispatch(&app, project_id, json!({ "n": n }), 30_000).await })
        })
        .collect::<Vec<_>>();

    let device = tokio::spawn({
        let fixture = fixture.clone();
        async move {
            let mut handled = HashSet::new();
            let mut answers = Vec::new();
            while handled.len() < 5 {
                let (status, listing) = fixture.list(&["pending"], None).await?;
                anyhow::ensure!(status == StatusCode::OK, "list failed: {listing}");
                for item in listing.as_array().cloned().unwrap_or_default() {
                    let request_id = Uuid::parse_str(item["id"].as_str().unwrap_or_default())?;
                    if !handled.insert(request_id) {
                        continue;
                    }
                    let fixture = fixture.clone();
                    answers.push(tokio::spawn(async move {
                        let (status, claimed) = fixture.claim(request_id, DEVICE_ID).await?;
                        anyhow::ensure!(status == StatusCode::OK, "claim failed: {claimed}");
                        let reply = json!({
                            "ok": true,
                            "name": "device.echo",
                            "value": { "n": item["arguments"]["n"] },
                        });
                        let (status, completed) =
                            fixture.complete(request_id, DEVICE_ID, reply).await?;
                        anyhow::ensure!(status == StatusCode::OK, "complete failed: {completed}");
                        Ok(())
                    }));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            for answer in join_all(answers).await {
                answer??;
            }
            anyhow::Ok(())
        }
    });

    let results = tokio::time::timeout(Duration::from_secs(20), join_all(dispatches))
        .await
        .map_err(|_| anyhow::anyhow!("held-open dispatches starved the pool"))?;
    for (n, result) in results.into_iter().enumerate() {
        let (status, body) = result??;
        assert_eq!(status, StatusCode::OK, "dispatch {n}: {body}");
        assert_eq!(body["ok"], json!(true), "dispatch {n}: {body}");
        assert_eq!(
            body["value"]["n"],
            json!(n),
            "dispatch {n} got another reply"
        );
    }
    tokio::time::timeout(Duration::from_secs(5), device).await???;

    fixture.cleanup().await
}

/// A device may claim a request, or claim it again, only inside its window.
/// A pending request past it is expired; a claimed one is left for its
/// device to complete, and no longer offered to anyone.
#[tokio::test]
async fn claims_are_refused_once_the_window_closes() -> anyhow::Result<()> {
    let fixture = Fixture::new(5, "provider-request-window").await?;

    let stale = fixture
        .insert_request("pending", -60, -1, None, None)
        .await?;
    let open = fixture.insert_request("pending", 0, 60, None, None).await?;
    let overdue = fixture
        .insert_request("claimed", -120, -60, Some(DEVICE_ID), None)
        .await?;

    let (status, listing) = fixture.list(&["pending", "claimed"], None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed_ids(&listing),
        vec![open],
        "only the open request is offered"
    );

    let (status, body) = fixture.claim(stale, DEVICE_ID).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["message"],
        json!("provider request expired before it was claimed")
    );
    let (stored_status, error) = fixture.stored(stale).await?;
    assert_eq!(stored_status, "expired");
    assert_eq!(
        error.as_deref(),
        Some("The provider request expired before a device claimed it.")
    );

    let (status, claimed) = fixture.claim(open, DEVICE_ID).await?;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["status"], json!("claimed"));
    let expires_at = chrono::DateTime::parse_from_rfc3339(
        claimed["expiresAt"]
            .as_str()
            .expect("claim returns expiresAt"),
    )?;
    assert!(expires_at > chrono::Utc::now(), "claimed inside its window");

    // Its own device may not start an overdue claimed request again, but may
    // still say how it went.
    let (status, body) = fixture.claim(overdue, DEVICE_ID).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(fixture.stored(overdue).await?.0, "claimed");
    let (status, completed) = fixture
        .complete(
            overdue,
            DEVICE_ID,
            json!({ "ok": true, "value": { "moved": true } }),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["status"], json!("completed"));
    assert!(fixture.answered_late(overdue).await?);

    // An older controller, during a rollout, queues without expires_at. Its
    // request closes after the longest wait a dispatch can ask for.
    let window: f64 = sql_one(
        &fixture.pool,
        "insert into project_provider_requests
            (id, project_id, provider_id, request_kind, status)
         values ($1, $2, $3, 'tool_call', 'pending')
         returning extract(epoch from expires_at - created_at)::float8",
        &[&Uuid::new_v4(), &fixture.project_id, &PROVIDER_ID],
    )
    .await?;
    assert_eq!(window, 120.0);
    crate::tests::assert_controller_only(
        &fixture.pool,
        &["project_provider_requests", "project_provider_devices"],
    )
    .await?;

    fixture.cleanup().await
}

/// An expired request, which no device claimed, takes no answer.
#[tokio::test]
async fn an_expired_request_takes_no_answer() -> anyhow::Result<()> {
    let fixture = Fixture::new(5, "provider-request-expiry").await?;
    let timeout = Some("Timed out waiting for the provider device to respond.");

    let never_claimed = fixture
        .insert_request("expired", -180, -60, None, timeout)
        .await?;
    let (status, body) = fixture
        .complete(never_claimed, DEVICE_ID, json!({ "ok": true }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["message"],
        json!("provider request expired before any device claimed it")
    );
    assert_eq!(fixture.stored(never_claimed).await?.0, "expired");

    fixture.cleanup().await
}

/// The dispatch stops waiting while the device still holds the request: the
/// request stays claimed, the reply says so, and the device's later answer is
/// kept and listed with the ended requests.
#[tokio::test]
async fn a_claimed_request_outlives_the_wait_and_keeps_its_late_answer() -> anyhow::Result<()> {
    let fixture = Fixture::new(5, "provider-request-late").await?;
    let app = fixture.app.clone();
    let project_id = fixture.project_id;

    let dispatch =
        tokio::spawn(async move { dispatch(&app, project_id, json!({ "n": 1 }), 5_000).await });

    let request_id = first_listed(&fixture, None).await?;
    let (status, claimed) = fixture.claim(request_id, DEVICE_ID).await?;
    assert_eq!(status, StatusCode::OK, "{claimed}");

    let (status, reply) = tokio::time::timeout(Duration::from_secs(15), dispatch).await???;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["ok"], json!(false));
    assert!(
        reply["error"]
            .as_str()
            .unwrap_or_default()
            .contains("may have run it, or may still"),
        "{reply}"
    );

    assert_eq!(fixture.stored(request_id).await?.0, "claimed");
    let (_, listing) = fixture.list(&["pending", "claimed"], None).await?;
    assert!(
        listed_ids(&listing).is_empty(),
        "a request past its window is not offered again: {listing}"
    );

    let (status, completed) = fixture
        .complete(
            request_id,
            DEVICE_ID,
            json!({ "ok": true, "name": "device.echo", "value": { "n": 1 } }),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert!(fixture.answered_late(request_id).await?);

    let (status, listing) = fixture.list(&["completed"], None).await?;
    assert_eq!(status, StatusCode::OK, "{listing}");
    let read = &listing[0];
    assert_eq!(read["id"], json!(request_id.to_string()));
    assert_eq!(read["response"]["value"]["n"], json!(1));

    fixture.cleanup().await
}

/// A request reports its age in milliseconds on the database clock, in a
/// listing and in a claim. One created 5 s ago is at least 5000 ms old, and
/// older only by as long as the test has run since.
#[tokio::test]
async fn every_copy_of_a_request_reports_its_age_in_milliseconds() -> anyhow::Result<()> {
    let fixture = Fixture::new(5, "provider-request-age").await?;
    let inserted = Instant::now();
    let request_id = fixture
        .insert_request("pending", -5, 60, None, None)
        .await?;
    let assert_age = |copy: &JsonValue, read: &str| {
        let age_ms = copy["ageMs"]
            .as_i64()
            .unwrap_or_else(|| panic!("{read} has no ageMs: {copy}"));
        // A little room for the database's clock against the test's.
        let ceiling = 5_100 + inserted.elapsed().as_millis() as i64;
        assert!(
            (5_000..ceiling).contains(&age_ms),
            "{read}: ageMs {age_ms}, expected 5000..{ceiling}"
        );
    };

    let (status, listing) = fixture.list(&["pending"], None).await?;
    assert_eq!(status, StatusCode::OK, "{listing}");
    assert_eq!(listed_ids(&listing), vec![request_id]);
    assert_age(&listing[0], "list");

    let (status, claimed) = fixture.claim(request_id, DEVICE_ID).await?;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_age(&claimed, "claim");

    fixture.cleanup().await
}

/// A request targeted at one device is offered to that device and claimable
/// only by it. Requests targeted at no device stay open to every device, and
/// a device's listing leaves out what another device holds. No route sets a
/// target yet, so the test sets it as the controller would.
#[tokio::test]
async fn a_targeted_request_is_offered_to_and_claimed_by_its_device_only() -> anyhow::Result<()> {
    let fixture = Fixture::new(5, "provider-request-target").await?;
    let app = fixture.app.clone();
    let project_id = fixture.project_id;

    let untargeted = fixture
        .insert_request("pending", -2, 60, None, None)
        .await?;
    let held_elsewhere = fixture
        .insert_request("claimed", -1, 60, Some(OTHER_DEVICE_ID), None)
        .await?;

    let dispatch =
        tokio::spawn(async move { dispatch(&app, project_id, json!({ "n": 1 }), 30_000).await });
    let targeted = first_listed(&fixture, Some(untargeted)).await?;
    sql(
        &fixture.pool,
        "update project_provider_requests set target_device_id = $2 where id = $1",
        &[&targeted, &DEVICE_ID],
    )
    .await?;

    let (status, listing) = fixture
        .list(&["pending", "claimed"], Some(OTHER_DEVICE_ID))
        .await?;
    assert_eq!(status, StatusCode::OK, "{listing}");
    assert_eq!(listed_ids(&listing), vec![untargeted, held_elsewhere]);
    let (status, listing) = fixture
        .list(&["pending", "claimed"], Some(DEVICE_ID))
        .await?;
    assert_eq!(status, StatusCode::OK, "{listing}");
    assert_eq!(listed_ids(&listing), vec![untargeted, targeted]);

    let mut events = fixture.state.events.subscribe();
    let (status, body) = fixture.claim(targeted, OTHER_DEVICE_ID).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        body["message"],
        json!("provider request is for another device")
    );
    assert_eq!(fixture.stored(targeted).await?.0, "pending");

    let (status, claimed) = fixture.claim(targeted, DEVICE_ID).await?;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["status"], json!("claimed"));
    assert_eq!(claimed["targetDeviceId"], json!(DEVICE_ID));

    let updates = updates_for(&mut events, targeted);
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert_eq!(updates[0].data["status"], json!("claimed"));
    assert_eq!(updates[0].data["targetDeviceId"], json!(DEVICE_ID));

    let (status, completed) = fixture
        .complete(
            targeted,
            DEVICE_ID,
            json!({ "ok": true, "name": "device.echo", "value": { "n": 1 } }),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{completed}");
    let (status, reply) = tokio::time::timeout(Duration::from_secs(10), dispatch).await???;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["value"]["n"], json!(1));

    fixture.cleanup().await
}

/// When a job ends, by a person's interrupt, its plan group's cancel, its
/// runtime's report or its space's deletion, its pending and claimed device
/// requests are canceled in the same transaction, and their requester's
/// streams are told, except of a deleted space's, which publishes nothing.
/// Other requests are left as they were.
#[tokio::test]
async fn a_job_that_ends_cancels_its_open_device_requests() -> anyhow::Result<()> {
    for ending in ["interrupt", "plan_group", "failed", "space_deleted"] {
        let label = format!("provider-request-job-{ending}");
        with_space(&label, false, |harness| async move {
            let space = &harness.space;
            let job = harness.send(space.owner, space.log, person()).await?;
            harness.lease(space.runtime).await?;
            // Only a grant's call makes a job's request: the job holds one.
            sql(
                &harness.pool,
                "update agent_jobs set grant_ids = array[gen_random_uuid()] where id = $1",
                &[&job.id],
            )
            .await?;
            let insert = |job: Option<Uuid>, status: &'static str, claimed_by| {
                harness.insert(NewRequest {
                    status,
                    requested_by: Some(space.owner),
                    job,
                    claimed_by,
                    ..NewRequest::default()
                })
            };
            let open = [
                insert(Some(job.id), "pending", None).await?,
                insert(Some(job.id), "claimed", Some(DEVICE_ID)).await?,
            ];
            let untouched = vec![
                insert(Some(job.id), "completed", Some(DEVICE_ID)).await?,
                insert(Some(Uuid::new_v4()), "pending", None).await?,
                insert(None, "claimed", Some(DEVICE_ID)).await?,
            ];

            let mut events = harness.state.events.subscribe();
            let owner = harness.token(space.owner);
            let path = match ending {
                "interrupt" => Some(format!("/conversations/{}/interrupt", space.log)),
                "plan_group" => {
                    let group = Uuid::new_v4();
                    sql(
                        &harness.pool,
                        "update agent_jobs set plan_group_id = $2 where id = $1",
                        &[&job.id, &group],
                    )
                    .await?;
                    Some(format!("/jobs/plan-groups/{group}/cancel"))
                }
                "failed" => {
                    let failed = json!({
                        "outcome": "failed",
                        "error_message": "The turn failed.",
                        "artifacts": [],
                    });
                    harness.complete(space.runtime, job.id, failed).await?;
                    None
                }
                _ => {
                    let mut connection = harness.pool.get().await?;
                    let mut transaction = connection.transaction().await?;
                    let work =
                        crate::project_work_cancellation::cancel_project_work_in_transaction(
                            &harness.state.config,
                            &mut transaction,
                            space.project_id,
                        )
                        .await
                        .map_err(|(status, body)| {
                            anyhow::anyhow!("cancel: {status} {}", body.0.message)
                        })?;
                    transaction.commit().await?;
                    assert_eq!(work.canceled_job_ids, vec![job.id]);
                    None
                }
            };
            if let Some(path) = path {
                let (status, body) = harness
                    .call("POST", path, Some(&owner), Some(json!({})))
                    .await?;
                assert_eq!(status, StatusCode::OK, "{ending}: {body}");
                assert_eq!(body["canceledJobIds"], json!([job.id]), "{ending}");
            }

            let requests = harness.requests_of(job.id).await?;
            assert_eq!(
                requests[..2],
                [canceled(open[0], None), canceled(open[1], None)],
                "{ending}"
            );
            let statuses: Vec<String> = sql_one(
                &harness.pool,
                "select array_agg(status order by array_position($1, id))
                   from project_provider_requests where id = any($1)",
                &[&untouched],
            )
            .await?;
            assert_eq!(statuses, ["completed", "pending", "claimed"], "{ending}");

            if ending != "space_deleted" {
                let mut canceled_events = Vec::new();
                while let Ok(event) = events.try_recv() {
                    if event.kind == "provider.request.updated" {
                        canceled_events.push(event);
                    }
                }
                assert_eq!(
                    canceled_events.len(),
                    open.len(),
                    "{ending}: {canceled_events:?}"
                );
                for event in &canceled_events {
                    assert!(
                        open.iter().any(|id| event.data["requestId"] == json!(id)),
                        "{ending}"
                    );
                    assert_eq!(event.data["status"], json!("canceled"), "{ending}");
                    assert_eq!(event.data["cancelReason"], JsonValue::Null, "{ending}");
                    // A job's request is its requester's alone.
                    assert_eq!(event.target_user_id, Some(space.owner), "{ending}");
                }
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// A job that holds no device grant has no request, since only a grant's
/// call makes one, so its end leaves the request table out of its
/// transaction: its runtime's report, a cancel, a steer and the expiry sweep
/// each end it while another transaction holds that table locked.
#[tokio::test]
async fn an_ordinary_jobs_end_takes_no_lock_on_the_request_table() -> anyhow::Result<()> {
    with_space(
        "provider-request-ordinary-job",
        false,
        |harness| async move {
            let space = &harness.space;
            let job = harness.send(space.owner, space.log, person()).await?;
            harness.lease(space.runtime).await?;
            let completed = json!({ "outcome": "succeeded", "summary": "Done." });
            with_requests_locked(&harness.pool, "completion", async {
                harness.complete(space.runtime, job.id, completed).await
            })
            .await?;

            let job = harness.send(space.owner, space.log, person()).await?;
            harness.lease(space.runtime).await?;
            sql(
                &harness.pool,
                "update runtimes
                    set capabilities = capabilities || '{\"activeTurnInput\": true}'::jsonb
                  where id = $1",
                &[&space.runtime],
            )
            .await?;
            sql(
                &harness.pool,
                "update agent_jobs
                    set active_input_ready_runtime_id = leased_by_runtime_id,
                        active_input_ready_expires_at = now() + interval '1 minute',
                        active_input_ready_turn_id = 'turn-1'
                  where id = $1",
                &[&job.id],
            )
            .await?;
            let steer = json!({
                "clientSendId": Uuid::new_v4().to_string(),
                "mode": "steer",
                "expectedActiveJobId": job.id,
                "request": { "promptText": "look left", "intent": "feature", "metadata": person() },
            });
            let owner = harness.token(space.owner);
            let path = format!("/conversations/{}/send-intents", space.log);
            let (status, body) = with_requests_locked(&harness.pool, "a steer", async {
                harness.call("POST", path, Some(&owner), Some(steer)).await
            })
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");

            let job = harness.send(space.owner, space.log, person()).await?;
            let path = format!("/jobs/{}/cancel", job.id);
            let (status, body) = with_requests_locked(&harness.pool, "a cancel", async {
                harness
                    .call("POST", path, Some(&owner), Some(json!({})))
                    .await
            })
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["canceledJobIds"], json!([job.id]));

            // A stop requeued it 20 minutes ago, and no runtime of the space runs.
            harness.end_turns().await?;
            let job = harness.send(space.owner, space.log, person()).await?;
            sql(
                &harness.pool,
                "update agent_jobs
                    set payload = payload || jsonb_build_object(
                          'requeuedAt', (now() - interval '20 minutes')::text)
                  where id = $1",
                &[&job.id],
            )
            .await?;
            sql(
                &harness.pool,
                "update runtimes set status = 'stopped' where project_id = $1",
                &[&space.project_id],
            )
            .await?;
            with_requests_locked(&harness.pool, "the expiry sweep", async {
                crate::runtime::expire_stale_requeued_jobs(
                    &harness.state,
                    &mut crate::background_loops::TickConnection::new(&harness.state.pool),
                )
                .await
            })
            .await?;
            let status: String = sql_one(
                &harness.pool,
                "select status from agent_jobs where id = $1",
                &[&job.id],
            )
            .await?;
            assert_eq!(status, "failed");
            Ok(())
        },
    )
    .await
}

/// Runs `end` while another transaction holds `project_provider_requests` in
/// ACCESS EXCLUSIVE mode, behind which an end that touched it would wait.
async fn with_requests_locked<T>(
    pool: &PgPool,
    what: &str,
    end: impl std::future::Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    let mut connection = pool.get().await?;
    let lock = connection.transaction().await?;
    lock.batch_execute("lock table project_provider_requests in access exclusive mode")
        .await?;
    let ended = tokio::time::timeout(Duration::from_secs(10), end).await;
    lock.rollback().await?;
    ended.map_err(|_| anyhow::anyhow!("{what} waited for the request table"))?
}

/// A job's request carries one person's call and its result: only that
/// person's own session lists, claims or completes it, and anyone else is
/// told it does not exist. Once its job has ended, a claim cancels it with
/// the job's other open requests instead of starting it.
#[tokio::test]
async fn a_jobs_request_is_its_requesters_alone_and_runs_only_while_its_job_does(
) -> anyhow::Result<()> {
    with_space(
        "provider-request-job-private",
        false,
        |harness| async move {
            let space = &harness.space;
            let job = harness.send(space.owner, space.log, person()).await?;
            harness.lease(space.runtime).await?;
            let first = harness.request(space.owner, None, Some(job.id)).await?;
            let second = harness.request(space.owner, None, Some(job.id)).await?;
            let owner = harness.token(space.owner);
            let member = harness.token(space.member);

            for token in [member.as_str(), SERVICE_ROLE] {
                let (status, listed) = harness.listed(token, None).await?;
                assert_eq!((status, listed), (StatusCode::OK, vec![]));
                let claimed = harness.act(token, first, "claim", DEVICE_ID).await?;
                assert_eq!(claimed, StatusCode::NOT_FOUND);
            }
            let (status, listing) = harness
                .call(
                    "GET",
                    format!(
                        "/projects/{}/provider-requests?providerId={PROVIDER_ID}&limit=20",
                        space.project_id
                    ),
                    Some(&owner),
                    None,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{listing}");
            assert_eq!(listed_ids(&listing), vec![first, second]);
            assert_eq!(listing[0]["jobId"], json!(job.id));

            assert_eq!(
                harness.act(&owner, first, "claim", DEVICE_ID).await?,
                StatusCode::OK
            );
            assert_eq!(
                harness.act(&member, first, "complete", DEVICE_ID).await?,
                StatusCode::NOT_FOUND
            );

            // The job ends without its end reaching these requests, as on a path
            // that does not cancel them: the next claim does.
            sql(
                &harness.pool,
                "update agent_jobs set status = 'failed', completed_at = now() where id = $1",
                &[&job.id],
            )
            .await?;
            let (status, body) = harness
                .call(
                    "POST",
                    format!(
                        "/projects/{}/provider-requests/{second}/claim",
                        space.project_id
                    ),
                    Some(&owner),
                    Some(json!({ "providerId": PROVIDER_ID, "deviceId": DEVICE_ID })),
                )
                .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["message"], json!("provider request's job has ended"));
            assert_eq!(
                harness.requests_of(job.id).await?,
                [canceled(first, None), canceled(second, None)]
            );
            Ok(())
        },
    )
    .await
}
