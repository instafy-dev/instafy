#![cfg(test)]

// Database-backed coverage for the provider-release fence on explicit stops.
// Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use crate::runtime;
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, test_origin_private_key,
    test_origin_public_key,
};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

/// A hosted runtime can sit in `requested` with its lease already detached:
/// the org-cap counter ignores it, but an explicit stop used to refuse it with
/// a 409 because no lease generation was left to release. Ensure commits the
/// lease before any provider call, so such a row has no allocation to release
/// and a user stop must be allowed to finish it locally. Every other status
/// without a lease keeps the fence.
#[tokio::test]
async fn user_stop_finishes_requested_managed_runtime_without_lease() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("runtime stop fence test").await?;

    let project_id = Uuid::new_v4();
    let requested_runtime_id = Uuid::new_v4();
    let requested_lease_id = Uuid::new_v4();
    let offline_runtime_id = Uuid::new_v4();
    let offline_lease_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status) VALUES ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        // Mirrors the row measured on prod: status requested, no endpoint,
        // no task ref, last_seen_at set, active_lease_id null.
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, updated_at
                 ) VALUES ($1, $2, 'instafy_cloud', 'requested', NULL, NULL, 600, now(), now())",
                &[&requested_runtime_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, updated_at
                 ) VALUES ($1, $2, 'instafy_cloud', 'offline', NULL, NULL, 600, now(), now())",
                &[&offline_runtime_id, &project_id],
            )
            .await?;
        for (lease_id, runtime_id) in [
            (requested_lease_id, requested_runtime_id),
            (offline_lease_id, offline_runtime_id),
        ] {
            connection
                .execute(
                    "INSERT INTO runtime_leases (
                         id, project_id, runtime_id, status, requested_at, launched_at, released_at
                     ) VALUES ($1, $2, $3, 'released', now(), now(), now())",
                    &[&lease_id, &project_id, &runtime_id],
                )
                .await?;
        }
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "runtime-stop-fence",
    );
    let app = runtime::router().with_state(build_test_state(pool.clone(), config));
    let stop_request = |runtime_id: Uuid| -> anyhow::Result<Request<Body>> {
        Ok(Request::builder()
            .method("POST")
            .uri("/runtime/stop")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer service-role-token")
            .body(Body::from(serde_json::to_vec(&json!({
                "runtime_id": runtime_id,
                "reason": "runtime_limit_takeover",
            }))?))?)
    };

    let response = app
        .clone()
        .oneshot(stop_request(requested_runtime_id)?)
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected stop response: {}",
        String::from_utf8_lossy(&body)
    );
    let body: serde_json::Value = serde_json::from_slice(&body)?;
    assert_eq!(body["ok"], true);
    assert_eq!(body["status_changed"], true);
    assert_eq!(body["provider_release_attempted"], false);
    assert!(body.get("skip_reason").is_none());

    {
        let connection = pool.get().await?;
        let runtime_row = connection
            .query_one(
                "SELECT status, active_lease_id FROM runtimes WHERE id = $1",
                &[&requested_runtime_id],
            )
            .await?;
        assert_eq!(runtime_row.get::<_, String>("status"), "stopped");
        assert_eq!(runtime_row.get::<_, Option<Uuid>>("active_lease_id"), None);

        let event_row = connection
            .query_one(
                "SELECT count(*)::bigint AS stopped_events,
                        max(data ->> 'reason') AS reason
                 FROM runtime_events
                 WHERE runtime_id = $1 AND kind = 'stopped'",
                &[&requested_runtime_id],
            )
            .await?;
        assert_eq!(event_row.get::<_, i64>("stopped_events"), 1);
        assert_eq!(
            event_row.get::<_, Option<String>>("reason").as_deref(),
            Some("runtime_limit_takeover")
        );

        // The released lease is left untouched; there was no generation to
        // release.
        let lease_status: String = connection
            .query_one(
                "SELECT status FROM runtime_leases WHERE id = $1",
                &[&requested_lease_id],
            )
            .await?
            .get(0);
        assert_eq!(lease_status, "released");
    }

    // Stopping again is idempotent for the now-stopped row.
    let repeat = app
        .clone()
        .oneshot(stop_request(requested_runtime_id)?)
        .await?;
    assert_eq!(repeat.status(), StatusCode::OK);
    let repeat_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(repeat.into_body(), usize::MAX).await?)?;
    assert_eq!(repeat_body["status_changed"], false);
    assert_eq!(repeat_body["skip_reason"], "already_stopped");

    // An offline heartbeat without a lease generation stays fenced exactly as
    // before: it may have a live provider allocation that nobody can prove
    // released.
    let fenced = app.oneshot(stop_request(offline_runtime_id)?).await?;
    let fenced_status = fenced.status();
    let fenced_body = to_bytes(fenced.into_body(), usize::MAX).await?;
    assert_eq!(
        fenced_status,
        StatusCode::CONFLICT,
        "unexpected offline stop response: {}",
        String::from_utf8_lossy(&fenced_body)
    );
    let fenced_json: serde_json::Value = serde_json::from_slice(&fenced_body)?;
    assert_eq!(
        fenced_json["message"],
        "provider-managed runtime is missing its active lease generation"
    );
    {
        let connection = pool.get().await?;
        let offline_status: String = connection
            .query_one(
                "SELECT status FROM runtimes WHERE id = $1",
                &[&offline_runtime_id],
            )
            .await?
            .get(0);
        assert_eq!(offline_status, "offline");
        connection
            .execute("DELETE FROM projects WHERE id = $1", &[&project_id])
            .await?;
    }

    Ok(())
}
