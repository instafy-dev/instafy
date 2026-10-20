//! The agent lease route on the migrated database, for a runtime that has
//! nothing to lease: such a poll is answered by one read, without the leasing
//! transaction and its row lock, while every job the lease query can take,
//! every refusal and every `last_seen_at` write stay what they were.

use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, pool_gets, require_origin_test_pool,
    require_origin_test_pool_with_max_size, test_origin_private_key, test_origin_public_key,
    with_shared_db_fixture, SharedDbFixture,
};
use crate::{agent, AppState};

const HOSTED_PROVIDER: &str = "instafy-cloud";

/// Longer than any lease the route answers on its own, far shorter than a
/// stop holding the runtime row.
const LEASE_ANSWER_TIMEOUT: Duration = Duration::from_secs(10);

fn hosted_config(key_id: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    config.strict_mode = false;
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

async fn seed_project(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
            &[project_id],
        )
        .await?;
    Ok(())
}

/// A ready hosted runtime of `project_id` whose `last_seen_at` is
/// `last_seen_age_seconds` old, or unset.
async fn add_runtime(
    pool: &PgPool,
    project_id: &Uuid,
    last_seen_age_seconds: Option<i64>,
) -> anyhow::Result<Uuid> {
    let runtime_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at, capabilities
             ) values (
                 $1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600,
                 now() - ($5::bigint * interval '1 second'), '{\"agent\": true}'::jsonb
             )",
            &[
                &runtime_id,
                project_id,
                &HOSTED_PROVIDER,
                &format!("idle-lease-poll-{runtime_id}"),
                &last_seen_age_seconds,
            ],
        )
        .await?;
    Ok(runtime_id)
}

async fn queue_job(
    pool: &PgPool,
    project_id: &Uuid,
    target_runtime_id: Option<&Uuid>,
    payload: JsonValue,
) -> anyhow::Result<Uuid> {
    let job_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into agent_jobs (id, project_id, status, intent, payload, target_runtime_id)
             values ($1, $2, 'queued', 'terminal_command', $3, $4)",
            &[&job_id, project_id, &PgJson(payload), &target_runtime_id],
        )
        .await?;
    Ok(job_id)
}

async fn finish_job(pool: &PgPool, job_id: &Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update agent_jobs set status = 'completed' where id = $1",
            &[job_id],
        )
        .await?;
    Ok(())
}

/// The runtime row's `last_seen_at` and `updated_at`.
async fn runtime_stamps(
    pool: &PgPool,
    runtime_id: &Uuid,
) -> anyhow::Result<(
    Option<chrono::DateTime<chrono::Utc>>,
    chrono::DateTime<chrono::Utc>,
)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select last_seen_at, updated_at from runtimes where id = $1",
            &[runtime_id],
        )
        .await?;
    Ok((row.get("last_seen_at"), row.get("updated_at")))
}

/// One lease poll as `runtime_id`, signed for `lease_id`, answered within
/// [`LEASE_ANSWER_TIMEOUT`] or an error naming what it waited on.
async fn lease(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<&Uuid>,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    lease_with_body(
        state,
        project_id,
        runtime_id,
        lease_id,
        json!({ "max": 1, "lease_seconds": 120 }),
    )
    .await
}

async fn lease_with_body(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<&Uuid>,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let bearer =
        crate::auth::issue_agent_token(&state.config, project_id, runtime_id, lease_id, None)
            .map_err(|(status, error)| {
                anyhow::anyhow!("issue the agent bearer: {status} {}", error.0.message)
            })?
            .token;
    let request = Request::builder()
        .method("POST")
        .uri("/agent/lease")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {bearer}"),
        )
        .body(Body::from(body.to_string()))?;
    let response = tokio::time::timeout(
        LEASE_ANSWER_TIMEOUT,
        agent::router().with_state(state.clone()).oneshot(request),
    )
    .await
    .map_err(|_| anyhow::anyhow!("the lease poll waited on the runtime row lock"))??;
    let status = response.status();
    let body: JsonValue =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    Ok((status, body))
}

fn leased_job_ids(body: &JsonValue) -> Vec<String> {
    body["jobs"]
        .as_array()
        .map(|jobs| {
            jobs.iter()
                .filter_map(|job| job["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A stop holds the runtime row `for update` while it decides the runtime's
/// jobs. A poll with nothing to lease does not queue behind it on a pooled
/// connection: it answers from one read and takes one checkout, and it writes
/// nothing to the row.
#[tokio::test]
async fn an_idle_lease_poll_answers_without_waiting_on_the_runtime_row() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("an_idle_lease_poll_answers_without_waiting").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id).await?;
        let runtime_id = add_runtime(&pool, &project_id, Some(5)).await?;
        // Another runtime's queued job is none of this one's business.
        let other_runtime_id = add_runtime(&pool, &project_id, Some(5)).await?;
        queue_job(&pool, &project_id, Some(&other_runtime_id), json!({})).await?;
        let state = build_test_state(pool.clone(), hosted_config("idle-lease-poll-lock"));
        let stamps_before = runtime_stamps(&pool, &runtime_id).await?;

        let mut stop_connection = pool.get().await?;
        let stop = stop_connection.transaction().await?;
        stop.query_one(
            "select id from runtimes where id = $1 for update",
            &[&runtime_id],
        )
        .await?;

        let gets_before = pool_gets(&pool);
        let (status, body) = lease(&state, &project_id, &runtime_id, None).await?;
        let gets = pool_gets(&pool) - gets_before;
        stop.rollback().await?;
        drop(stop_connection);

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "jobs": [] }));
        assert_eq!(gets, 1, "an idle poll takes one pool checkout");
        assert_eq!(runtime_stamps(&pool, &runtime_id).await?, stamps_before);
        Ok(())
    })
    .await
}

/// `last_seen_at` is written when it is unset or older than the touch
/// interval, as the leasing transaction always did, and left alone otherwise.
#[tokio::test]
async fn an_idle_lease_poll_writes_last_seen_exactly_when_it_is_due() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("an_idle_lease_poll_writes_last_seen").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id).await?;
        let state = build_test_state(pool.clone(), hosted_config("idle-lease-poll-last-seen"));
        let interval = crate::runtime::RUNTIME_LAST_SEEN_TOUCH_INTERVAL_SECONDS;

        let fresh = add_runtime(&pool, &project_id, Some(interval - 10)).await?;
        let fresh_before = runtime_stamps(&pool, &fresh).await?;
        let (status, body) = lease(&state, &project_id, &fresh, None).await?;
        assert_eq!((status, body), (StatusCode::OK, json!({ "jobs": [] })));
        assert_eq!(runtime_stamps(&pool, &fresh).await?, fresh_before);

        for last_seen_age in [Some(interval + 1), None] {
            let due = add_runtime(&pool, &project_id, last_seen_age).await?;
            let (_, updated_before) = runtime_stamps(&pool, &due).await?;
            let (status, body) = lease(&state, &project_id, &due, None).await?;
            assert_eq!((status, body), (StatusCode::OK, json!({ "jobs": [] })));
            let (last_seen, updated) = runtime_stamps(&pool, &due).await?;
            let age = chrono::Utc::now() - last_seen.expect("the poll writes last_seen_at");
            assert!(
                age.num_seconds() < 5,
                "last_seen_at {last_seen_age:?}s old was not touched"
            );
            assert!(updated > updated_before);
        }
        Ok(())
    })
    .await
}

/// Every queued job the lease query may hand this runtime still reaches it:
/// one with no target, one targeting it, and spread jobs that target another
/// runtime, under either spelling of their routing metadata.
#[tokio::test]
async fn an_idle_lease_poll_still_leases_every_job_the_runtime_may_take() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("an_idle_lease_poll_still_leases").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id).await?;
        let runtime_id = add_runtime(&pool, &project_id, Some(5)).await?;
        let other_runtime_id = add_runtime(&pool, &project_id, Some(5)).await?;
        let state = build_test_state(pool.clone(), hosted_config("idle-lease-poll-jobs"));

        let cases = [
            ("untargeted", None, json!({})),
            ("targeted at this runtime", Some(&runtime_id), json!({})),
            (
                "spread, targeted elsewhere",
                Some(&other_runtime_id),
                json!({ "metadata": { "runtimeRouting": { "strategy": "spread" } } }),
            ),
            (
                "spread by snake-case flag, targeted elsewhere",
                Some(&other_runtime_id),
                json!({ "metadata": { "runtime_routing": { "allow_runtime_spread": "true" } } }),
            ),
        ];
        for (case, target, payload) in cases {
            let job_id = queue_job(&pool, &project_id, target, payload).await?;
            let (status, body) = lease(&state, &project_id, &runtime_id, None).await?;
            assert_eq!(status, StatusCode::OK, "{case}: {body}");
            assert_eq!(
                leased_job_ids(&body),
                vec![job_id.to_string()],
                "{case} was not leased"
            );
            finish_job(&pool, &job_id).await?;
        }

        // Without routing metadata, a job targeting another runtime is that
        // runtime's alone.
        let elsewhere = queue_job(&pool, &project_id, Some(&other_runtime_id), json!({})).await?;
        let (status, body) = lease(&state, &project_id, &runtime_id, None).await?;
        assert_eq!((status, body), (StatusCode::OK, json!({ "jobs": [] })));
        let (status, body) = lease(&state, &project_id, &other_runtime_id, None).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(leased_job_ids(&body), vec![elsewhere.to_string()]);
        Ok(())
    })
    .await
}

/// A runtime that may not lease is refused with the leasing transaction's own
/// answer, idle or not.
#[tokio::test]
async fn an_idle_lease_poll_keeps_every_refusal() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("an_idle_lease_poll_keeps_every_refusal").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id).await?;
        let state = build_test_state(pool.clone(), hosted_config("idle-lease-poll-refusals"));

        let unregistered = Uuid::new_v4();
        let (status, body) = lease(&state, &project_id, &unregistered, None).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(
            body["message"],
            "agent token runtime is not registered for project"
        );

        let draining = add_runtime(&pool, &project_id, Some(5)).await?;
        pool.get()
            .await?
            .execute(
                "update runtimes set status = 'draining' where id = $1",
                &[&draining],
            )
            .await?;
        let (status, body) = lease(&state, &project_id, &draining, None).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["message"], "runtime is not eligible to lease jobs");

        // A token from an earlier generation of a runtime that has moved on.
        let rotated = add_runtime(&pool, &project_id, Some(5)).await?;
        let stale_lease_id = Uuid::new_v4();
        let (status, body) = lease(&state, &project_id, &rotated, Some(&stale_lease_id)).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(
            body["message"],
            "agent token runtime lease scope is no longer active"
        );
        Ok(())
    })
    .await
}

/// A project with a pinned runtime checks the pin on the poll's own
/// connection: an idle poll from another runtime still takes one checkout,
/// and that runtime's leases stay restricted to jobs that target it.
#[tokio::test]
async fn a_pinned_runtime_preference_is_checked_on_the_poll_connection() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_pinned_runtime_preference_is_checked").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id).await?;
        let preferred = add_runtime(&pool, &project_id, Some(5)).await?;
        let other = add_runtime(&pool, &project_id, Some(5)).await?;
        let state = build_test_state(pool.clone(), hosted_config("idle-lease-poll-preference"));
        state
            .runtime_preferences
            .set(project_id, Some(preferred), Some("test".to_string()), None)
            .await;

        let gets_before = pool_gets(&pool);
        let (status, body) = lease(&state, &project_id, &other, None).await?;
        assert_eq!((status, body), (StatusCode::OK, json!({ "jobs": [] })));
        assert_eq!(pool_gets(&pool) - gets_before, 1);

        let job_id = queue_job(&pool, &project_id, None, json!({})).await?;
        let (status, body) = lease(&state, &project_id, &other, None).await?;
        assert_eq!((status, body), (StatusCode::OK, json!({ "jobs": [] })));
        let (status, body) = lease(&state, &project_id, &preferred, None).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(leased_job_ids(&body), vec![job_id.to_string()]);
        Ok(())
    })
    .await
}

/// A poll that may wait for `wait_ms`, spawned, answering with how long it took.
fn spawn_waiting_lease(
    state: &AppState,
    project_id: Uuid,
    runtime_id: Uuid,
    wait_ms: u64,
) -> tokio::task::JoinHandle<anyhow::Result<(StatusCode, JsonValue, Duration)>> {
    let state = state.clone();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let (status, body) = lease_with_body(
            &state,
            &project_id,
            &runtime_id,
            None,
            json!({ "max": 1, "lease_seconds": 120, "wait_ms": wait_ms }),
        )
        .await?;
        Ok((status, body, started.elapsed()))
    })
}

/// A held poll answers as soon as a run event shows there may be work, and
/// leaves the job queued: the runtime leases it in the next, fresh poll, so a
/// runtime that gave up on a long request can never be leased a job.
#[tokio::test]
async fn a_held_lease_poll_answers_at_once_when_work_is_queued() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_held_lease_poll_answers_at_once").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id).await?;
        let runtime_id = add_runtime(&pool, &project_id, Some(5)).await?;
        let state = build_test_state(pool.clone(), hosted_config("lease-wait-wake"));

        let poll = spawn_waiting_lease(&state, project_id, runtime_id, 8_000);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let job_id = queue_job(&pool, &project_id, Some(&runtime_id), json!({})).await?;
        crate::publish_controller_event(
            &state.events,
            "run.queued",
            Some(project_id),
            None,
            None,
            Some(job_id),
            json!({ "status": "queued" }),
        );

        let (status, body, elapsed) = poll.await??;
        assert_eq!(
            (status, body),
            (StatusCode::OK, json!({ "jobs": [], "waited": true }))
        );
        // Woken by the event, well before the two-second re-check.
        assert!(elapsed < Duration::from_millis(1_500), "took {elapsed:?}");
        let job_status: String = pool
            .get()
            .await?
            .query_one("select status from agent_jobs where id = $1", &[&job_id])
            .await?
            .get(0);
        assert_eq!(job_status, "queued", "a held poll never leases");

        let (status, body, _) =
            spawn_waiting_lease(&state, project_id, runtime_id, 8_000).await??;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(leased_job_ids(&body), vec![job_id.to_string()]);
        Ok(())
    })
    .await
}

/// While it waits a poll holds no pool connection, other projects' runs do
/// not end its wait, and it then answers empty and says it waited.
#[tokio::test]
async fn a_waiting_lease_poll_frees_its_connection_and_answers_empty_after_its_wait(
) -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool_with_max_size("a_waiting_lease_poll_frees_its_connection", 1)
            .await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        seed_project(&pool, &project_id).await?;
        let runtime_id = add_runtime(&pool, &project_id, Some(5)).await?;
        let state = build_test_state(pool.clone(), hosted_config("lease-wait-empty"));

        let poll = spawn_waiting_lease(&state, project_id, runtime_id, 700);
        tokio::time::sleep(Duration::from_millis(250)).await;
        let connection = tokio::time::timeout(Duration::from_millis(300), pool.get())
            .await
            .map_err(|_| anyhow::anyhow!("the waiting poll held the only pool connection"))??;
        drop(connection);
        crate::publish_controller_event(
            &state.events,
            "run.queued",
            Some(Uuid::new_v4()),
            None,
            None,
            None,
            json!({ "status": "queued" }),
        );

        let (status, body, elapsed) = poll.await??;
        assert_eq!(
            (status, body),
            (StatusCode::OK, json!({ "jobs": [], "waited": true }))
        );
        assert!(elapsed >= Duration::from_millis(700), "took {elapsed:?}");
        Ok(())
    })
    .await
}
