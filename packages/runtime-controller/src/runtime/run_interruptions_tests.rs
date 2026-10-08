//! Database-backed tests of a turn a runtime stop cuts off: the requeue marks
//! its run, `/runtime/stop` and `/runtime/remove` announce it, and the
//! existing lease resumes it. Each stop path that can requeue a running turn
//! is driven once, here for the routes and in the sweeps' own tests for the
//! sweeps. Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value as JsonValue};
use tokio::sync::broadcast::Receiver;
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt as _;
use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig};
use crate::state::ControllerEvent;
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, spawn_aborting,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, AbortingTask,
    SharedDbFixture,
};
use crate::AppState;

use super::REQUEUED_JOB_EXPIRY_SECONDS;

const PROVIDER_ID: &str = "run_interruptions_test";
const LAST_MESSAGE: &str = "Reading the repository";

/// The runtime a turn runs on.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeShape {
    /// A ready provider-managed runtime with an active lease generation: a
    /// stop quarantines it, then the stand-in provider releases it.
    Hosted,
    /// A hosted runtime left `requested` without a lease generation: a stop
    /// finishes it locally, without the quarantine.
    Unleased,
}

/// A space whose runtime is running a turn: an `in_progress` run at
/// `agent:leased` and its job, leased by that runtime.
pub(crate) struct RunningTurn {
    pub(crate) pool: PgPool,
    pub(crate) state: AppState,
    pub(crate) project_id: Uuid,
    pub(crate) conversation_id: Uuid,
    pub(crate) runtime_id: Uuid,
    pub(crate) runtime_lease_id: Uuid,
    pub(crate) job_id: Uuid,
    pub(crate) run_id: Uuid,
    releases: Arc<Mutex<usize>>,
    _provider: AbortingTask<()>,
}

/// A run as the database holds it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunRecord {
    pub(crate) status: String,
    pub(crate) progress_stage: Option<String>,
    pub(crate) last_message: Option<String>,
    pub(crate) metadata: JsonValue,
    pub(crate) updated_at: DateTime<Utc>,
}

impl RunningTurn {
    /// Seed `project_id` (the caller's fixture deletes it) with a runtime of
    /// `shape` running a turn. The stand-in provider answers every release
    /// with `release`.
    pub(crate) async fn start(
        pool: PgPool,
        project_id: Uuid,
        shape: RuntimeShape,
        release: StatusCode,
    ) -> anyhow::Result<Self> {
        let releases = Arc::new(Mutex::new(0));
        let provider_app = axum::Router::new().route(
            "/runtime/release",
            axum::routing::post({
                let releases = releases.clone();
                move || {
                    let releases = releases.clone();
                    async move {
                        *releases.lock().unwrap() += 1;
                        release
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let provider = spawn_aborting(async move {
            axum::serve(listener, provider_app)
                .await
                .expect("serve stand-in provider");
        });
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "run-interruptions",
        );
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: PROVIDER_ID.to_string(),
            display_name: "Stand-in provider".to_string(),
            kind: "test".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some(format!("http://{address}")),
            auth_token: None,
            metadata: None,
        }];
        let state = build_test_state(pool.clone(), config);

        let conversation_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let runtime_lease_id = Uuid::new_v4();
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, metadata, visibility)
                 values ($1, $2, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id],
            )
            .await?;
        match shape {
            RuntimeShape::Hosted => {
                connection
                    .execute(
                        "insert into runtimes
                            (id, project_id, provider, status, endpoint_url,
                             idle_ttl_seconds, last_seen_at)
                         values ($1, $2, $3, 'ready', 'http://runtime.test', 600, now())",
                        &[&runtime_id, &project_id, &PROVIDER_ID],
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
            }
            RuntimeShape::Unleased => {
                // The shape of tests_runtime_stop_fence.rs: requested, no
                // endpoint and no lease generation.
                connection
                    .execute(
                        "insert into runtimes
                            (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                         values ($1, $2, 'instafy_cloud', 'requested', 600, now())",
                        &[&runtime_id, &project_id],
                    )
                    .await?;
            }
        }
        drop(connection);

        let (job_id, run_id) = insert_turn(
            &pool,
            project_id,
            conversation_id,
            runtime_id,
            "in_progress",
            true,
            json!({ "agent": { "handle": "octo" } }),
        )
        .await?;

        Ok(Self {
            pool,
            state,
            project_id,
            conversation_id,
            runtime_id,
            runtime_lease_id,
            job_id,
            run_id,
            releases,
            _provider: provider,
        })
    }

    /// Provider releases so far.
    pub(crate) fn releases(&self) -> usize {
        *self.releases.lock().unwrap()
    }

    /// `POST uri` on the runtime routes as the service role.
    pub(crate) async fn post(
        &self,
        uri: &str,
        body: JsonValue,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let response = super::super::router()
            .with_state(self.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, "Bearer service-role-token")
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        Ok((
            status,
            serde_json::from_slice(&body).unwrap_or(JsonValue::Null),
        ))
    }

    /// `POST /runtime/stop` of the turn's runtime with `reason`.
    pub(crate) async fn stop(&self, reason: &str) -> anyhow::Result<(StatusCode, JsonValue)> {
        self.post(
            "/runtime/stop",
            json!({ "runtime_id": self.runtime_id, "reason": reason }),
        )
        .await
    }

    /// Make the runtime look dead: it last answered an hour ago and the
    /// turn's job lease has lapsed, so a stop that spares runtimes with live
    /// work still takes it.
    pub(crate) async fn let_the_runtime_go_quiet(&self) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        connection
            .execute(
                "update runtimes set last_seen_at = now() - interval '1 hour' where id = $1",
                &[&self.runtime_id],
            )
            .await?;
        connection
            .execute(
                "update agent_jobs
                 set lease_expires_at = now() - interval '1 minute',
                     heartbeat_at = now() - interval '1 hour'
                 where id = $1",
                &[&self.job_id],
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn run(&self, run_id: Uuid) -> anyhow::Result<RunRecord> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, progress_stage, last_message, metadata, updated_at
                 from runs where id = $1",
                &[&run_id],
            )
            .await?;
        Ok(RunRecord {
            status: row.get("status"),
            progress_stage: row.get("progress_stage"),
            last_message: row.get("last_message"),
            metadata: row
                .get::<_, Option<JsonValue>>("metadata")
                .unwrap_or(JsonValue::Null),
            updated_at: row.get("updated_at"),
        })
    }

    /// A job's status and payload.
    pub(crate) async fn job(&self, job_id: Uuid) -> anyhow::Result<(String, JsonValue)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, payload from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        Ok((
            row.get("status"),
            row.get::<_, PgJson<JsonValue>>("payload").0,
        ))
    }

    /// The turn's run after a stop with `reason` requeued its job.
    pub(crate) async fn assert_interrupted(&self, reason: &str) -> anyhow::Result<RunRecord> {
        self.assert_turn_interrupted(self.job_id, self.run_id, reason)
            .await
    }

    /// The run `run_id` after a stop with `reason` requeued its job `job_id`:
    /// queued at `requeued`, with the interruption beside its other metadata,
    /// stamped at the requeue's time.
    pub(crate) async fn assert_turn_interrupted(
        &self,
        job_id: Uuid,
        run_id: Uuid,
        reason: &str,
    ) -> anyhow::Result<RunRecord> {
        let run = self.run(run_id).await?;
        assert_eq!(run.status, "queued", "{run:?}");
        assert_eq!(run.progress_stage.as_deref(), Some("requeued"));
        assert_eq!(run.last_message.as_deref(), Some(LAST_MESSAGE));
        assert_eq!(run.metadata["managedAiUsed"], json!(false), "{run:?}");
        let interruption = &run.metadata["interruption"];
        assert_eq!(interruption["reason"], json!(reason), "{run:?}");
        assert_eq!(interruption["jobId"], json!(job_id));

        let (job_status, payload) = self.job(job_id).await?;
        assert_eq!(job_status, "queued");
        assert_eq!(payload["requeuedReason"], json!(reason));
        assert_eq!(interruption["interruptedAt"], payload["requeuedAt"]);
        let interrupted_at = json_time(&interruption["interruptedAt"])?;
        assert_eq!(interrupted_at, run.updated_at);
        assert_eq!(
            json_time(&interruption["resumeBy"])? - interrupted_at,
            ChronoDuration::seconds(REQUEUED_JOB_EXPIRY_SECONDS)
        );
        Ok(run)
    }

    /// A runtime that comes up afterwards leases the turn's job through the
    /// ordinary lease, which resumes its run: `in_progress` at
    /// `agent:leased`, the requeue stamp gone from the job, and the
    /// interruption kept on the run as history.
    pub(crate) async fn assert_resumed_by_a_lease(&self) -> anyhow::Result<()> {
        let mut connection = self.pool.get().await?;
        let transaction = connection.transaction().await?;
        let leased = crate::agent::lease_next_agent_job(
            &transaction,
            &self.project_id,
            Some(&Uuid::new_v4()),
            120,
            true,
            false,
            false,
            false,
            None,
            None,
            false,
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("lease: {status} {}", body.0.message))?;
        transaction.commit().await?;
        drop(connection);
        assert_eq!(leased.map(|job| job.id), Some(self.job_id));

        let run = self.run(self.run_id).await?;
        assert_eq!(run.status, "in_progress", "{run:?}");
        assert_eq!(run.progress_stage.as_deref(), Some("agent:leased"));
        assert!(run.metadata.get("interruption").is_some(), "{run:?}");
        let (job_status, payload) = self.job(self.job_id).await?;
        assert_eq!(job_status, "leased");
        assert!(payload.get("requeuedAt").is_none(), "{payload}");
        assert!(payload.get("requeuedReason").is_none(), "{payload}");
        Ok(())
    }
}

/// Seed a turn of `conversation_id`: a run with `run_status` and its job,
/// leased by `runtime_id` when `leased`, otherwise queued pinned to it. The
/// job carries `metadata`.
pub(crate) async fn insert_turn(
    pool: &PgPool,
    project_id: Uuid,
    conversation_id: Uuid,
    runtime_id: Uuid,
    run_status: &str,
    leased: bool,
    metadata: JsonValue,
) -> anyhow::Result<(Uuid, Uuid)> {
    let job_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let (progress, stage) = if leased {
        (40.0_f64, "agent:leased")
    } else {
        (0.0_f64, "agent:queued")
    };
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into runs
                (id, project_id, conversation_id, run_type, status, progress,
                 progress_stage, last_message, metadata)
             values ($1, $2, $3, 'prompt', $4, $5, $6, $7, '{\"managedAiUsed\": false}'::jsonb)",
            &[
                &run_id,
                &project_id,
                &conversation_id,
                &run_status,
                &progress,
                &stage,
                &LAST_MESSAGE,
            ],
        )
        .await?;
    let payload = PgJson(json!({ "prompt_text": "Tidy the README", "metadata": metadata }));
    if leased {
        connection
            .execute(
                "insert into agent_jobs
                    (id, project_id, run_id, conversation_id, intent, status, payload,
                     lease_attempts, leased_by_runtime_id, target_runtime_id, leased_at,
                     lease_expires_at, heartbeat_at)
                 values ($1, $2, $3, $4, 'feature', 'leased', $5, 1, $6, $6, now(),
                         now() + interval '10 minutes', now())",
                &[
                    &job_id,
                    &project_id,
                    &run_id,
                    &conversation_id,
                    &payload,
                    &runtime_id,
                ],
            )
            .await?;
    } else {
        connection
            .execute(
                "insert into agent_jobs
                    (id, project_id, run_id, conversation_id, intent, status, payload,
                     target_runtime_id)
                 values ($1, $2, $3, $4, 'feature', 'queued', $5, $6)",
                &[
                    &job_id,
                    &project_id,
                    &run_id,
                    &conversation_id,
                    &payload,
                    &runtime_id,
                ],
            )
            .await?;
    }
    Ok((job_id, run_id))
}

fn json_time(value: &JsonValue) -> anyhow::Result<DateTime<Utc>> {
    let text = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("not a timestamp: {value}"))?;
    Ok(DateTime::parse_from_rfc3339(text)?.with_timezone(&Utc))
}

/// The `run.progress` events published for `run_id` since the last call.
pub(crate) fn run_progress_events(
    events: &mut Receiver<ControllerEvent>,
    run_id: Uuid,
) -> Vec<ControllerEvent> {
    let mut found = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.kind == "run.progress" && event.run_id == Some(run_id) {
            found.push(event);
        }
    }
    found
}

fn fixture(project_id: Uuid) -> SharedDbFixture {
    SharedDbFixture {
        projects: vec![project_id],
        ..Default::default()
    }
}

/// The announcement of an interrupted turn: the stored run, stamped with the
/// time the stop interrupted it.
fn assert_announces(event: &ControllerEvent, turn: &RunningTurn, run: &RunRecord, reason: &str) {
    assert_eq!(event.job_id, Some(turn.job_id));
    assert_eq!(event.project_id, Some(turn.project_id));
    assert_eq!(event.conversation_id, Some(turn.conversation_id));
    assert_eq!(
        event.channels,
        vec![format!("conversation:{}", turn.conversation_id)]
    );
    assert_eq!(event.timestamp, run.updated_at);
    assert_eq!(event.data["status"], "queued");
    assert_eq!(event.data["stage"], "requeued");
    assert_eq!(event.data["jobId"], json!(turn.job_id));
    assert_eq!(event.data["run"]["status"], "queued");
    assert_eq!(event.data["run"]["progress_stage"], "requeued");
    assert_eq!(
        event.data["run"]["metadata"]["interruption"]["reason"],
        json!(reason)
    );
    assert!(event.data.get("percent").is_none());
}

/// The Stop button on a hosted machine (the Oct 7 path): the stop commits
/// the quarantine that requeues the turn, then waits on the provider's
/// release. The turn is queued from the quarantine on, and the stop
/// announces it once it answers.
#[tokio::test]
async fn a_users_stop_of_a_hosted_machine_marks_and_announces_the_turn() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("hosted user stop interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], true, "{body}");
        assert_eq!(turn.releases(), 1);

        let run = turn.assert_interrupted("user_stop").await?;
        let announced = run_progress_events(&mut events, turn.run_id);
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_announces(&announced[0], &turn, &run, "user_stop");

        turn.assert_resumed_by_a_lease().await
    })
    .await
}

/// A stop whose provider release fails answers 502 with its quarantine in
/// place: the turn it requeued is queued all the same, and announced.
#[tokio::test]
async fn a_failed_provider_release_still_announces_the_requeued_turn() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("failed release interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
        assert_eq!(body["skip_reason"], "provider_cleanup_pending", "{body}");

        let run = turn.assert_interrupted("user_stop").await?;
        let announced = run_progress_events(&mut events, turn.run_id);
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_announces(&announced[0], &turn, &run, "user_stop");
        Ok(())
    })
    .await
}

/// A runtime with no lease generation left is stopped without the
/// quarantine (`perform_runtime_stop` directly); its turn is marked the same.
#[tokio::test]
async fn a_users_stop_of_a_runtime_without_a_lease_marks_and_announces_the_turn(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("unleased user stop interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Unleased,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], true, "{body}");
        assert_eq!(body["provider_release_attempted"], false, "{body}");

        let run = turn.assert_interrupted("user_stop").await?;
        let announced = run_progress_events(&mut events, turn.run_id);
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_announces(&announced[0], &turn, &run, "user_stop");
        Ok(())
    })
    .await
}

/// Only a turn that was running is marked: a job still queued for the
/// runtime keeps its queued run exactly as it was, and a browser-bound turn
/// fails as before.
#[tokio::test]
async fn requeue_marks_only_turns_that_were_running() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("interruption scope test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let (queued_job, queued_run) = insert_turn(
            &pool,
            project_id,
            turn.conversation_id,
            turn.runtime_id,
            "queued",
            false,
            json!({}),
        )
        .await?;
        let (approval_job, approval_run) = insert_turn(
            &pool,
            project_id,
            turn.conversation_id,
            turn.runtime_id,
            "awaiting_approval",
            true,
            json!({}),
        )
        .await?;
        let (browser_job, browser_run) = insert_turn(
            &pool,
            project_id,
            turn.conversation_id,
            turn.runtime_id,
            "in_progress",
            true,
            json!({ "browserTransport": "desktop-personal" }),
        )
        .await?;
        let queued_before = turn.run(queued_run).await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::OK, "{body}");

        turn.assert_interrupted("user_stop").await?;
        turn.assert_turn_interrupted(approval_job, approval_run, "user_stop")
            .await?;

        let (queued_job_status, queued_payload) = turn.job(queued_job).await?;
        assert_eq!(queued_job_status, "queued");
        assert_eq!(queued_payload["requeuedReason"], "user_stop");
        assert_eq!(
            turn.run(queued_run).await?,
            queued_before,
            "a turn that never started is left as it was"
        );

        let browser = turn.run(browser_run).await?;
        assert_eq!(browser.status, "failed");
        assert!(
            browser.metadata.get("interruption").is_none(),
            "{browser:?}"
        );
        assert_eq!(turn.job(browser_job).await?.0, "failed");

        let mut announced_runs = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.kind == "run.progress" {
                announced_runs.push(event.run_id);
            }
        }
        announced_runs.sort();
        let mut expected = vec![Some(turn.run_id), Some(approval_run)];
        expected.sort();
        assert_eq!(announced_runs, expected);
        Ok(())
    })
    .await
}

/// A stop that is skipped, here for another lease generation, requeues
/// nothing: the turn keeps running and nothing is announced.
#[tokio::test]
async fn a_skipped_stop_leaves_the_turn_running() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("skipped stop interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let before = turn.run(turn.run_id).await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn
            .post(
                "/runtime/stop",
                json!({
                    "runtime_id": turn.runtime_id,
                    "reason": "user_stop",
                    "expected_lease_id": Uuid::new_v4(),
                }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["skip_reason"], "runtime_lease_mismatch", "{body}");

        let after = turn.run(turn.run_id).await?;
        assert_eq!(after, before);
        assert_eq!(after.status, "in_progress");
        assert_eq!(turn.job(turn.job_id).await?.0, "leased");
        assert!(run_progress_events(&mut events, turn.run_id).is_empty());
        Ok(())
    })
    .await
}

/// A repeated Stop finds the runtime already stopped and changes nothing. It
/// announces the same stored record again, with the same timestamp, so a
/// viewer's clock on the waiting turn does not restart.
#[tokio::test]
async fn repeating_the_stop_republishes_the_same_record() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("repeated stop interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let first = turn.assert_interrupted("user_stop").await?;
        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], false, "{body}");
        assert_eq!(body["skip_reason"], "already_stopped", "{body}");

        assert_eq!(turn.run(turn.run_id).await?, first);
        let announced = run_progress_events(&mut events, turn.run_id);
        assert_eq!(announced.len(), 2, "{announced:?}");
        for event in &announced {
            assert_announces(event, &turn, &first, "user_stop");
        }
        assert_eq!(announced[0].data, announced[1].data);
        Ok(())
    })
    .await
}

/// Remove on a hosted machine, which quarantines like a stop: the turn is
/// marked, announced and resumed by the next lease.
#[tokio::test]
async fn a_users_remove_marks_and_announces_the_turn() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("user remove interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn
            .post(
                "/runtime/remove",
                json!({ "runtimeId": turn.runtime_id, "reason": "user_remove" }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true, "{body}");

        let run = turn.assert_interrupted("user_remove").await?;
        let announced = run_progress_events(&mut events, turn.run_id);
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_announces(&announced[0], &turn, &run, "user_remove");

        turn.assert_resumed_by_a_lease().await
    })
    .await
}

/// Taking over the organization's hosted slot from another space stops this
/// space's machine through `/runtime/stop` with `runtime_limit_takeover`.
#[tokio::test]
async fn a_runtime_limit_takeover_marks_the_turn_it_requeues() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("takeover interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;

        let (status, body) = turn.stop("runtime_limit_takeover").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], true, "{body}");

        turn.assert_interrupted("runtime_limit_takeover").await?;
        turn.assert_resumed_by_a_lease().await
    })
    .await
}

/// The pool-retirement drain stops a live runtime with its active turn
/// (`/operator/runtime-drain/stop`). It does not announce the turn; viewers
/// see the record on their next load of the runs.
#[tokio::test]
async fn a_pool_retirement_drain_marks_the_turn_it_requeues() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("drain interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn
            .post(
                "/operator/runtime-drain/stop",
                json!({
                    "runtimeId": turn.runtime_id,
                    "projectId": turn.project_id,
                    "leaseId": turn.runtime_lease_id,
                }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["statusChanged"], true, "{body}");

        turn.assert_interrupted("pool_retirement").await?;
        assert!(run_progress_events(&mut events, turn.run_id).is_empty());
        turn.assert_resumed_by_a_lease().await
    })
    .await
}

/// After a Stop, a runtime that registers and leases through `/agent/lease`
/// resumes the turn with no code of its own: the lease flips the queued run
/// back to `in_progress` and says so.
#[tokio::test]
async fn a_lease_resumes_the_interrupted_turn() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("interrupted turn lease test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        turn.assert_interrupted("user_stop").await?;

        let next_runtime_id = Uuid::new_v4();
        pool.get()
            .await?
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, endpoint_url, idle_ttl_seconds,
                     last_seen_at, capabilities)
                 values ($1, $2, $3, 'ready', 'http://runtime.test', 600, now(),
                         '{\"agent\": true}'::jsonb)",
                &[&next_runtime_id, &project_id, &PROVIDER_ID],
            )
            .await?;
        let token = crate::auth::issue_agent_token(
            &turn.state.config,
            &project_id,
            &next_runtime_id,
            None,
            None,
        )
        .map_err(|(status, body)| anyhow::anyhow!("agent token: {status} {}", body.0.message))?
        .token;
        let mut events = turn.state.events.subscribe();
        let response = crate::agent::router()
            .with_state(turn.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/agent/lease")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::from(
                        json!({ "max": 1, "lease_seconds": 120 }).to_string(),
                    ))?,
            )
            .await?;
        let status = response.status();
        let body: JsonValue =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["jobs"][0]["id"], json!(turn.job_id), "{body}");

        let run = turn.run(turn.run_id).await?;
        assert_eq!(run.status, "in_progress");
        assert_eq!(run.progress_stage.as_deref(), Some("agent:leased"));
        let (job_status, payload) = turn.job(turn.job_id).await?;
        assert_eq!(job_status, "leased");
        assert!(payload.get("requeuedAt").is_none(), "{payload}");
        assert!(payload.get("requeuedReason").is_none(), "{payload}");

        let resumed = run_progress_events(&mut events, turn.run_id);
        assert_eq!(resumed.len(), 1, "{resumed:?}");
        assert_eq!(resumed[0].data["status"], "in_progress");
        assert_eq!(resumed[0].data["stage"], "agent:leased");
        assert_eq!(resumed[0].data["run"]["status"], "in_progress");
        Ok(())
    })
    .await
}
