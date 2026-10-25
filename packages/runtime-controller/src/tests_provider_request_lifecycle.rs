#![cfg(test)]

// Database-backed coverage for the provider request lifecycle: held-open
// dispatches against a small pool, claim windows and late completions.
// Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::Router;
use futures_util::future::join_all;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::config::PgPool;
use crate::tests::{
    build_app_config, build_test_state, call_router, require_origin_test_pool_with_max_size,
    test_origin_private_key, test_origin_public_key,
};

const PROVIDER_ID: &str = "device:lifecycle-test";
const DEVICE_ID: &str = "device-1";
const OTHER_DEVICE_ID: &str = "device-2";
const SERVICE_ROLE: &str = "Bearer service-role-token";

#[derive(Clone)]
struct Fixture {
    pool: PgPool,
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
        let app = crate::provider_requests::router().with_state(state);
        Ok(Self {
            pool,
            app,
            project_id,
        })
    }

    async fn list(&self, statuses: &[&str]) -> anyhow::Result<(StatusCode, JsonValue)> {
        call(
            &self.app,
            "GET",
            format!(
                "/projects/{}/provider-requests?providerId={PROVIDER_ID}&statuses={}&limit=20",
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

/// The first request the listing offers, once there is one.
async fn first_listed(fixture: &Fixture) -> anyhow::Result<Uuid> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, listing) = fixture.list(&["pending"]).await?;
            if let Some(request_id) = listed_ids(&listing).first().copied() {
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
                let (status, listing) = fixture.list(&["pending"]).await?;
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

    let (status, listing) = fixture.list(&["pending", "claimed"]).await?;
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

    let request_id = first_listed(&fixture).await?;
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
    let (_, listing) = fixture.list(&["pending", "claimed"]).await?;
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

    let (status, listing) = fixture.list(&["completed"]).await?;
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

    let (status, listing) = fixture.list(&["pending"]).await?;
    assert_eq!(status, StatusCode::OK, "{listing}");
    assert_eq!(listed_ids(&listing), vec![request_id]);
    assert_age(&listing[0], "list");

    let (status, claimed) = fixture.claim(request_id, DEVICE_ID).await?;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_age(&claimed, "claim");

    fixture.cleanup().await
}
