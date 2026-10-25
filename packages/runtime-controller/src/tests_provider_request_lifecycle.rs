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
    build_app_config, build_test_state, call_router, require_origin_test_pool_with_max_size,
    test_origin_private_key, test_origin_public_key,
};
use crate::AppState;

const PROVIDER_ID: &str = "device:lifecycle-test";
const DEVICE_ID: &str = "device-1";
const OTHER_DEVICE_ID: &str = "device-2";
const SERVICE_ROLE: &str = "Bearer service-role-token";

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
        let request_id = Uuid::new_v4();
        self.pool
            .get()
            .await?
            .execute(
                "insert into project_provider_requests (
                    id, project_id, provider_id, request_kind, tool_name, arguments, status,
                    claimed_by_device_id, claimed_at, error, created_at, updated_at, expires_at
                 ) values (
                    $1, $2, $3, 'tool_call', 'device.move', '{}'::jsonb, $4, $5::text,
                    case when $5::text is null then null else now() + $6::bigint * interval '1 second' end,
                    $7, now() + $6::bigint * interval '1 second', now(),
                    now() + $8::bigint * interval '1 second'
                 )",
                &[
                    &request_id,
                    &self.project_id,
                    &PROVIDER_ID,
                    &status,
                    &claimed_by,
                    &created_in,
                    &error,
                    &expires_in,
                ],
            )
            .await?;
        Ok(request_id)
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
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select completed_at > expires_at from project_provider_requests where id = $1",
                &[&request_id],
            )
            .await?
            .get(0))
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
    call_router(app, Some(SERVICE_ROLE), method, uri, body).await
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

fn listed_ids(listing: &JsonValue) -> Vec<Uuid> {
    listing
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["id"].as_str())
                .filter_map(|id| Uuid::parse_str(id).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// The first pending request the listing offers, other than `except`, once
/// there is one.
async fn first_listed(fixture: &Fixture, except: Option<Uuid>) -> anyhow::Result<Uuid> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, listing) = fixture.list(&["pending"], None).await?;
            if let Some(request_id) = listed_ids(&listing)
                .into_iter()
                .find(|id| Some(*id) != except)
            {
                return anyhow::Ok(request_id);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("the dispatch never queued its request"))?
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
    let window: f64 = fixture
        .pool
        .get()
        .await?
        .query_one(
            "insert into project_provider_requests
                (id, project_id, provider_id, request_kind, status)
             values ($1, $2, $3, 'tool_call', 'pending')
             returning extract(epoch from expires_at - created_at)::float8",
            &[&Uuid::new_v4(), &fixture.project_id, &PROVIDER_ID],
        )
        .await?
        .get(0);
    assert_eq!(window, 120.0);

    fixture.cleanup().await
}

/// A request an older controller expired after a device claimed it still
/// takes that device's answer, late; one no device claimed takes none.
#[tokio::test]
async fn an_expired_request_takes_only_its_claimant_answer() -> anyhow::Result<()> {
    let fixture = Fixture::new(5, "provider-request-legacy-expiry").await?;
    let timeout = Some("Timed out waiting for the provider device to respond.");

    let claimed_then_expired = fixture
        .insert_request("expired", -180, -60, Some(DEVICE_ID), timeout)
        .await?;
    let (status, body) = fixture
        .complete(claimed_then_expired, OTHER_DEVICE_ID, json!({ "ok": true }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, completed) = fixture
        .complete(
            claimed_then_expired,
            DEVICE_ID,
            json!({ "ok": false, "error": "blocked" }),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["status"], json!("failed"));
    assert_eq!(completed["error"], json!("blocked"));
    assert!(fixture.answered_late(claimed_then_expired).await?);

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
            .contains("may still complete it"),
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
    fixture
        .pool
        .get()
        .await?
        .execute(
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

/// A space whose agent job has a turn running, with a provider attached, as
/// the job-made requests below need it.
struct JobFixture {
    space: crate::tests_managed_ai_refund::ReservedManagedAiPrompt,
    app: Router,
    conversation_id: Uuid,
}

impl JobFixture {
    async fn new(label: &str) -> anyhow::Result<Self> {
        let Some(space) =
            crate::tests_managed_ai_refund::seed_reserved_managed_ai_prompt(label).await?
        else {
            anyhow::bail!(
                "provider request job tests require TEST_DATABASE_URL; run them through `pnpm test:controller`"
            );
        };
        let connection = space.pool.get().await?;
        connection
            .execute(
                "insert into project_integrations (id, project_id, provider, status, connection_type)
                 values ($1, $2, $3, 'attached', 'device')",
                &[&Uuid::new_v4(), &space.project_id, &PROVIDER_ID],
            )
            .await?;
        let conversation_id: Uuid = connection
            .query_one(
                "select conversation_id from agent_jobs where id = $1",
                &[&space.job_id],
            )
            .await?
            .get(0);
        drop(connection);
        let app = crate::provider_requests::router()
            .merge(crate::conversations::router())
            .merge(crate::send_intents::router())
            .with_state(space.state.clone());
        Ok(Self {
            space,
            app,
            conversation_id,
        })
    }

    fn token(&self, user_id: Uuid) -> anyhow::Result<String> {
        let issued = crate::auth::issue_controller_token(&self.space.config, &user_id)
            .map_err(|(status, body)| anyhow::anyhow!("token: {status} {}", body.0.message))?;
        Ok(format!("Bearer {}", issued.token))
    }

    /// The job's turn, leased by a runtime that takes words while it runs.
    async fn lease_job(&self) -> anyhow::Result<()> {
        let runtime_id = Uuid::new_v4();
        let connection = self.space.pool.get().await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, capabilities)
                 values ($1, $2, 'default', 'ready', '{\"activeTurnInput\": true}'::jsonb)",
                &[&runtime_id, &self.space.project_id],
            )
            .await?;
        connection
            .execute(
                "update agent_jobs
                    set status = 'leased',
                        leased_by_runtime_id = $2,
                        leased_at = now(),
                        lease_expires_at = now() + interval '5 minutes',
                        active_input_ready_runtime_id = $2,
                        active_input_ready_expires_at = now() + interval '5 minutes',
                        active_input_ready_turn_id = 'turn-1'
                  where id = $1",
                &[&self.space.job_id, &runtime_id],
            )
            .await?;
        Ok(())
    }

    /// A device request of `job_id`, as the job's own call would leave it.
    async fn insert_request(
        &self,
        job_id: Option<Uuid>,
        status: &str,
        claimed_by: Option<&str>,
    ) -> anyhow::Result<Uuid> {
        let request_id = Uuid::new_v4();
        self.space
            .pool
            .get()
            .await?
            .execute(
                "insert into project_provider_requests (
                    id, project_id, provider_id, request_kind, tool_name, arguments, status,
                    requested_by, job_id, claimed_by_device_id, claimed_at, created_at,
                    updated_at, expires_at
                 ) values (
                    $1, $2, $3, 'tool_call', 'device.move', '{}'::jsonb, $4, $5, $6, $7::text,
                    case when $7::text is null then null else now() end, now(), now(),
                    now() + interval '60 seconds'
                 )",
                &[
                    &request_id,
                    &self.space.project_id,
                    &PROVIDER_ID,
                    &status,
                    &self.space.owner_user_id,
                    &job_id,
                    &claimed_by,
                ],
            )
            .await?;
        Ok(request_id)
    }

    /// Each request's status and cancel reason.
    async fn requests(
        &self,
        ids: &[Uuid],
    ) -> anyhow::Result<Vec<(String, Option<String>, Option<String>)>> {
        let connection = self.space.pool.get().await?;
        let mut stored = Vec::new();
        for id in ids {
            let row = connection
                .query_one(
                    "select status, cancel_reason, error from project_provider_requests where id = $1",
                    &[id],
                )
                .await?;
            stored.push((row.get(0), row.get(1), row.get(2)));
        }
        Ok(stored)
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        self.space
            .pool
            .get()
            .await?
            .execute(
                "delete from project_provider_requests where project_id = $1",
                &[&self.space.project_id],
            )
            .await?;
        self.space.cleanup().await
    }
}

/// A canceled request as stored: with `reason` `steered` by a steer, with no
/// reason by any other end of its job.
fn canceled(reason: Option<&str>) -> (String, Option<String>, Option<String>) {
    let error = match reason {
        Some("steered") => "The provider request was canceled because its turn was steered.",
        _ => "The provider request was canceled.",
    };
    (
        "canceled".to_string(),
        reason.map(str::to_string),
        Some(error.to_string()),
    )
}

/// When a job ends, by a person's interrupt, its plan group's cancel, its
/// runtime's report or its space's deletion, its pending and claimed device
/// requests are canceled in the same transaction, and their requester's
/// streams are told, except of a deleted space's, which publishes nothing.
/// Other requests are left as they were.
#[tokio::test]
async fn a_job_that_ends_cancels_its_open_device_requests() -> anyhow::Result<()> {
    for ending in ["interrupt", "plan_group", "failed", "space_deleted"] {
        let fixture = JobFixture::new(&format!("provider-request-job-{ending}")).await?;
        let job_id = Some(fixture.space.job_id);
        let open = vec![
            fixture.insert_request(job_id, "pending", None).await?,
            fixture
                .insert_request(job_id, "claimed", Some(DEVICE_ID))
                .await?,
        ];
        let answered = fixture
            .insert_request(job_id, "completed", Some(DEVICE_ID))
            .await?;
        let another_job = fixture
            .insert_request(Some(Uuid::new_v4()), "pending", None)
            .await?;
        let no_job = fixture
            .insert_request(None, "claimed", Some(DEVICE_ID))
            .await?;

        let mut events = fixture.space.state.events.subscribe();
        match ending {
            "interrupt" | "plan_group" => {
                let uri = if ending == "interrupt" {
                    format!("/conversations/{}/interrupt", fixture.conversation_id)
                } else {
                    let group = Uuid::new_v4();
                    fixture
                        .space
                        .pool
                        .get()
                        .await?
                        .execute(
                            "update agent_jobs set plan_group_id = $2 where id = $1",
                            &[&fixture.space.job_id, &group],
                        )
                        .await?;
                    format!("/jobs/plan-groups/{group}/cancel")
                };
                let (status, body) = call_router(
                    &fixture.app,
                    Some(&fixture.token(fixture.space.owner_user_id)?),
                    "POST",
                    uri,
                    Some(json!({})),
                )
                .await?;
                assert_eq!(status, StatusCode::OK, "{ending}: {body}");
                assert_eq!(
                    body["canceledJobIds"],
                    json!([fixture.space.job_id]),
                    "{ending}"
                );
            }
            "failed" => {
                let status = crate::tests_managed_ai_refund::post_agent_complete(
                    &fixture.space,
                    json!({
                        "job_id": fixture.space.job_id,
                        "outcome": "failed",
                        "error_message": "The turn failed.",
                        "artifacts": [],
                    }),
                )
                .await?;
                assert_eq!(status, StatusCode::OK);
            }
            _ => {
                let mut connection = fixture.space.pool.get().await?;
                let mut transaction = connection.transaction().await?;
                let work = crate::project_work_cancellation::cancel_project_work_in_transaction(
                    &fixture.space.state.config,
                    &mut transaction,
                    fixture.space.project_id,
                )
                .await
                .map_err(|(status, body)| anyhow::anyhow!("cancel: {status} {}", body.0.message))?;
                transaction.commit().await?;
                assert_eq!(work.canceled_job_ids, vec![fixture.space.job_id]);
            }
        }

        assert_eq!(
            fixture.requests(&open).await?,
            vec![canceled(None), canceled(None)],
            "{ending}"
        );
        let untouched = fixture.requests(&[answered, another_job, no_job]).await?;
        let statuses: Vec<&str> = untouched
            .iter()
            .map(|(status, ..)| status.as_str())
            .collect();
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
                assert_eq!(
                    event.target_user_id,
                    Some(fixture.space.owner_user_id),
                    "{ending}"
                );
            }
        }
        fixture.cleanup().await?;
    }
    Ok(())
}

/// A job's request carries one person's call and its result: only that
/// person's own session lists, claims or completes it, and anyone else is
/// told it does not exist. Once its job has ended, a claim cancels it with
/// the job's other open requests instead of starting it.
#[tokio::test]
async fn a_jobs_request_is_its_requesters_alone_and_runs_only_while_its_job_does(
) -> anyhow::Result<()> {
    let fixture = JobFixture::new("provider-request-job-private").await?;
    fixture.lease_job().await?;
    let job_id = Some(fixture.space.job_id);
    let first = fixture.insert_request(job_id, "pending", None).await?;
    let second = fixture.insert_request(job_id, "pending", None).await?;
    let owner = fixture.token(fixture.space.owner_user_id)?;
    let member = fixture.token(fixture.space.other_user_id)?;
    let project_id = fixture.space.project_id;
    let listing_uri =
        format!("/projects/{project_id}/provider-requests?providerId={PROVIDER_ID}&limit=20");
    let claim_body = json!({ "providerId": PROVIDER_ID, "deviceId": DEVICE_ID });

    for authorization in [member.as_str(), SERVICE_ROLE] {
        let (status, listing) = call_router(
            &fixture.app,
            Some(authorization),
            "GET",
            listing_uri.clone(),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{listing}");
        assert!(listed_ids(&listing).is_empty(), "{listing}");
        let (status, body) = call_router(
            &fixture.app,
            Some(authorization),
            "POST",
            format!("/projects/{project_id}/provider-requests/{first}/claim"),
            Some(claim_body.clone()),
        )
        .await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }
    let (status, listing) =
        call_router(&fixture.app, Some(&owner), "GET", listing_uri, None).await?;
    assert_eq!(status, StatusCode::OK, "{listing}");
    assert_eq!(listed_ids(&listing), vec![first, second]);
    assert_eq!(listing[0]["jobId"], json!(fixture.space.job_id));

    let (status, claimed) = call_router(
        &fixture.app,
        Some(&owner),
        "POST",
        format!("/projects/{project_id}/provider-requests/{first}/claim"),
        Some(claim_body.clone()),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    let (status, body) = call_router(
        &fixture.app,
        Some(&member),
        "POST",
        format!("/projects/{project_id}/provider-requests/{first}/complete"),
        Some(
            json!({ "providerId": PROVIDER_ID, "deviceId": DEVICE_ID, "response": { "ok": true } }),
        ),
    )
    .await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    // The job ends without its end reaching these requests, as on a path
    // that does not cancel them: the next claim does.
    fixture
        .space
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs set status = 'failed', completed_at = now() where id = $1",
            &[&fixture.space.job_id],
        )
        .await?;
    let (status, body) = call_router(
        &fixture.app,
        Some(&owner),
        "POST",
        format!("/projects/{project_id}/provider-requests/{second}/claim"),
        Some(claim_body),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["message"], json!("provider request's job has ended"));
    assert_eq!(
        fixture.requests(&[first, second]).await?,
        vec![canceled(None), canceled(None)]
    );

    fixture.cleanup().await
}

/// A steer cancels the device call its turn waits on, in the transaction
/// that records the new words, and the turn goes on. The canceled call
/// answers only once the turn's runtime took the words, so the turn's next
/// step reads them rather than finishing the old plan without them.
#[tokio::test]
async fn a_steered_device_call_answers_once_the_runtime_took_the_new_words() -> anyhow::Result<()> {
    let fixture = JobFixture::new("provider-request-steer").await?;
    fixture.lease_job().await?;
    let owner = fixture.token(fixture.space.owner_user_id)?;
    let project_id = fixture.space.project_id;

    let call = {
        let app = fixture.app.clone();
        let owner = owner.clone();
        tokio::spawn(async move {
            call_router(
                &app,
                Some(&owner),
                "POST",
                format!("/projects/{project_id}/provider-tools/call"),
                Some(json!({
                    "providerId": PROVIDER_ID,
                    "name": "device.move",
                    "timeoutMs": 20_000,
                })),
            )
            .await
        })
    };
    // The call is the job's, as the job's own credential would make it.
    let request_id = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let row = fixture
                .space
                .pool
                .get()
                .await?
                .query_opt(
                    "update project_provider_requests set job_id = $2
                      where project_id = $1 and status = 'pending'
                  returning id",
                    &[&project_id, &fixture.space.job_id],
                )
                .await?;
            if let Some(row) = row {
                return anyhow::Ok(row.get::<_, Uuid>(0));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("the call never queued its request"))??;

    let (status, body) = call_router(
        &fixture.app,
        Some(&owner),
        "POST",
        format!("/conversations/{}/send-intents", fixture.conversation_id),
        Some(json!({
            "clientSendId": Uuid::new_v4().to_string(),
            "mode": "steer",
            "expectedActiveJobId": fixture.space.job_id,
            "request": { "promptText": "stop and turn left" },
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        fixture.requests(&[request_id]).await?,
        vec![canceled(Some("steered"))]
    );

    // The words are recorded and not yet taken: the call has not answered.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !call.is_finished(),
        "the steered call answered before its runtime took the new words"
    );

    // The runtime takes them; the call answers, and says nothing ran.
    fixture
        .space
        .pool
        .get()
        .await?
        .execute(
            "update agent_job_inputs set status = 'applied', applied_at = now() where job_id = $1",
            &[&fixture.space.job_id],
        )
        .await?;
    let (status, reply) = tokio::time::timeout(Duration::from_secs(2), call).await???;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(
        reply["error"],
        json!("The provider request was canceled because its turn was steered.")
    );
    assert_eq!(reply["noDeviceReply"], json!("never_claimed"));
    let job_status: String = fixture
        .space
        .pool
        .get()
        .await?
        .query_one(
            "select status from agent_jobs where id = $1",
            &[&fixture.space.job_id],
        )
        .await?
        .get(0);
    assert_eq!(job_status, "leased");

    fixture.cleanup().await
}
