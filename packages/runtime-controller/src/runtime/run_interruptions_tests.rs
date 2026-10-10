//! Database-backed tests of a turn a runtime stop cuts off: the requeue marks
//! its run, `/runtime/stop` and `/runtime/remove` announce it (and a person's
//! stop itself) before the provider release, and the existing lease resumes
//! it. Each stop path that can requeue a running turn is driven once, here for
//! the routes and in the sweeps' own tests for the sweeps. Requires
//! `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value as JsonValue};
use tokio::sync::broadcast::Receiver;
use tokio::sync::{watch, Notify};
use tokio::time::timeout;
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
    /// What the stand-in provider answers a release with.
    release_answer: Arc<Mutex<StatusCode>>,
    /// Whether the stand-in provider answers a release; while it is `false`
    /// every release waits.
    releases_open: watch::Sender<bool>,
    /// Told when the provider is asked for a release.
    release_asked: Arc<Notify>,
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
    /// with `release` until [`Self::answer_releases_with`] changes it.
    pub(crate) async fn start(
        pool: PgPool,
        project_id: Uuid,
        shape: RuntimeShape,
        release: StatusCode,
    ) -> anyhow::Result<Self> {
        let releases = Arc::new(Mutex::new(0));
        let release_answer = Arc::new(Mutex::new(release));
        let (releases_open, open) = watch::channel(true);
        let release_asked = Arc::new(Notify::new());
        let provider_app = axum::Router::new().route(
            "/runtime/release",
            axum::routing::post({
                let releases = releases.clone();
                let release_answer = release_answer.clone();
                let release_asked = release_asked.clone();
                move || {
                    let releases = releases.clone();
                    let release_answer = release_answer.clone();
                    let release_asked = release_asked.clone();
                    let mut open = open.clone();
                    async move {
                        *releases.lock().unwrap() += 1;
                        release_asked.notify_one();
                        let _ = open.wait_for(|open| *open).await;
                        let answer = *release_answer.lock().unwrap();
                        answer
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
            release_answer,
            releases_open,
            release_asked,
            _provider: provider,
        })
    }

    /// Provider releases so far.
    pub(crate) fn releases(&self) -> usize {
        *self.releases.lock().unwrap()
    }

    /// Have the stand-in provider answer every later release with `release`.
    pub(crate) fn answer_releases_with(&self, release: StatusCode) {
        *self.release_answer.lock().unwrap() = release;
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

    /// `POST uri` while the provider holds the release it is asked for, and
    /// `while_releasing` once it has been asked: the answer, and what
    /// `while_releasing` found while the stop waited on the provider.
    pub(crate) async fn post_while_releasing<T>(
        &self,
        uri: &str,
        body: JsonValue,
        while_releasing: impl std::future::Future<Output = T>,
    ) -> anyhow::Result<(StatusCode, JsonValue, T)> {
        self.releases_open.send_replace(false);
        let during_release = async {
            let asked = timeout(Duration::from_secs(10), self.release_asked.notified())
                .await
                .is_ok();
            let found = if asked {
                Some(while_releasing.await)
            } else {
                None
            };
            self.releases_open.send_replace(true);
            found
        };
        let (answered, found) = tokio::join!(self.post(uri, body), during_release);
        let (status, body) = answered?;
        let found = found.ok_or_else(|| {
            anyhow::anyhow!("the stop answered {status} {body} without asking for a release")
        })?;
        Ok((status, body, found))
    }

    /// `POST uri` while the provider holds the release it is asked for: the
    /// answer, and what `events` received until the release was asked for,
    /// that is what the stop published before the provider released the
    /// machine.
    pub(crate) async fn post_holding_the_release(
        &self,
        uri: &str,
        body: JsonValue,
        events: &mut Receiver<ControllerEvent>,
    ) -> anyhow::Result<(StatusCode, JsonValue, Vec<ControllerEvent>)> {
        self.post_while_releasing(uri, body, async { drain(events) })
            .await
    }

    /// The runtime's entry in its space's `GET /projects/:id/runtime/status`.
    pub(crate) async fn status_entry(&self) -> anyhow::Result<JsonValue> {
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

/// Every event published since the last call.
pub(crate) fn drain(events: &mut Receiver<ControllerEvent>) -> Vec<ControllerEvent> {
    let mut found = Vec::new();
    while let Ok(event) = events.try_recv() {
        found.push(event);
    }
    found
}

/// The events of `kind` among `events`, and for `run.progress` only those of
/// `run_id`.
fn of_kind<'a>(
    events: &'a [ControllerEvent],
    kind: &str,
    run_id: Uuid,
) -> Vec<&'a ControllerEvent> {
    events
        .iter()
        .filter(|event| {
            event.kind == kind && (kind != "run.progress" || event.run_id == Some(run_id))
        })
        .collect()
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

/// The `runtime.stopped` of a person's stop, as a platform stop publishes
/// it: the reason, the runtime, and the work left queued in the space, here
/// the turn the stop requeued.
pub(crate) fn assert_runtime_stopped(
    event: &ControllerEvent,
    turn: &RunningTurn,
    reason: &str,
    source: &str,
) {
    assert_eq!(event.kind, "runtime.stopped");
    assert_eq!(event.project_id, Some(turn.project_id));
    assert_eq!(
        event.data,
        json!({
            "runtimeId": turn.runtime_id,
            "status": "stopped",
            "reason": reason,
            "source": source,
            "queuedJobCount": 1,
        })
    );
}

/// What a person's stop publishes once it has committed: one
/// `runtime.stopped` with `reason`, then the turn it interrupted, so a tab
/// holds the space before it hears of the turn.
fn assert_publishes_a_persons_stop(
    published: &[ControllerEvent],
    turn: &RunningTurn,
    run: &RunRecord,
    reason: &str,
    source: &str,
) {
    let stopped = of_kind(published, "runtime.stopped", turn.run_id);
    assert_eq!(stopped.len(), 1, "{published:?}");
    assert_runtime_stopped(stopped[0], turn, reason, source);
    let announced = of_kind(published, "run.progress", turn.run_id);
    assert_eq!(announced.len(), 1, "{published:?}");
    assert_announces(announced[0], turn, run, reason);
    let position = |kind: &str| published.iter().position(|event| event.kind == kind);
    assert!(
        position("runtime.stopped") < position("run.progress"),
        "{published:?}"
    );
}

/// Nothing about the stop or the turn: no `runtime.stopped` and no
/// `run.progress` of the turn's run.
fn assert_publishes_nothing_of_the_stop(published: &[ControllerEvent], turn: &RunningTurn) {
    assert!(
        of_kind(published, "runtime.stopped", turn.run_id).is_empty(),
        "{published:?}"
    );
    assert!(
        of_kind(published, "run.progress", turn.run_id).is_empty(),
        "{published:?}"
    );
}

/// The Stop button on a hosted machine (the Oct 7 path): the stop commits
/// the quarantine that requeues the turn, then waits on the provider's
/// release, which can take a minute. The turn is queued from the quarantine
/// on. The stop publishes `runtime.stopped` and announces the turn as soon as
/// the quarantine commits: on Oct 10 another tab that heard nothing during
/// the release started the machine again, and the stopped turn resumed.
#[tokio::test]
async fn a_users_stop_of_a_hosted_machine_is_published_before_the_release() -> anyhow::Result<()> {
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

        let (status, body, before_release) = turn
            .post_holding_the_release(
                "/runtime/stop",
                json!({ "runtime_id": turn.runtime_id, "reason": "user_stop" }),
                &mut events,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], true, "{body}");
        assert_eq!(turn.releases(), 1);

        let run = turn.assert_interrupted("user_stop").await?;
        assert_publishes_a_persons_stop(&before_release, &turn, &run, "user_stop", "runtime_stop");
        assert_publishes_nothing_of_the_stop(&drain(&mut events), &turn);

        turn.assert_resumed_by_a_lease().await
    })
    .await
}

/// While a stop's provider release runs, the runtime is `requested` and
/// unseen on the lease it ran on, which by `status` and `launchRequestedAt`
/// alone is a launch that stalled: on Oct 10 a tab read a stopped machine
/// that way and started it again. The status entry says which stop holds
/// it, and since when, until the stop is done.
#[tokio::test]
async fn the_runtime_status_tells_a_stops_release_from_a_launch() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("stop status interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let running = turn.status_entry().await?;
        assert!(running.get("stopRequestedAt").is_none(), "{running}");
        assert!(running.get("stopReason").is_none(), "{running}");

        let (status, body, releasing) = turn
            .post_while_releasing(
                "/runtime/stop",
                json!({ "runtime_id": turn.runtime_id, "reason": "user_stop" }),
                turn.status_entry(),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let releasing = releasing?;
        assert_eq!(releasing["status"], "requested", "{releasing}");
        assert_eq!(releasing["lastSeenAt"], JsonValue::Null, "{releasing}");
        assert_eq!(
            releasing["launchRequestedAt"], running["launchRequestedAt"],
            "{releasing}"
        );
        assert_eq!(releasing["stopReason"], "user_stop", "{releasing}");
        // The quarantine's time, which is also when it interrupted the turn.
        let run = turn.assert_interrupted("user_stop").await?;
        assert_eq!(json_time(&releasing["stopRequestedAt"])?, run.updated_at);

        let stopped = turn.status_entry().await?;
        assert_eq!(stopped["status"], "stopped", "{stopped}");
        assert!(stopped.get("stopRequestedAt").is_none(), "{stopped}");
        assert!(stopped.get("stopReason").is_none(), "{stopped}");
        Ok(())
    })
    .await
}

/// A stop whose provider release fails answers 502 with its quarantine in
/// place: the turn it requeued is queued all the same, and the stop and the
/// turn are published.
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
        assert_publishes_a_persons_stop(
            &drain(&mut events),
            &turn,
            &run,
            "user_stop",
            "runtime_stop",
        );
        // The quarantine stays until a retry releases the machine, and so
        // does what the status entry says of it.
        let quarantined = turn.status_entry().await?;
        assert_eq!(quarantined["status"], "requested", "{quarantined}");
        assert_eq!(quarantined["stopReason"], "user_stop", "{quarantined}");
        assert_eq!(json_time(&quarantined["stopRequestedAt"])?, run.updated_at);
        Ok(())
    })
    .await
}

/// A runtime with no lease generation left is stopped without the
/// quarantine (`perform_runtime_stop` directly); its turn is marked, and the
/// stop and the turn published, the same.
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
        assert_publishes_a_persons_stop(
            &drain(&mut events),
            &turn,
            &run,
            "user_stop",
            "runtime_stop",
        );
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
/// nothing: the turn keeps running, and neither the stop nor the turn is
/// published.
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
        assert_eq!(turn.releases(), 0);
        assert_publishes_nothing_of_the_stop(&drain(&mut events), &turn);
        Ok(())
    })
    .await
}

/// A stop the controller refuses, here with 409 for a hosted runtime that is
/// ready without its lease generation, rolls back: the turn keeps running,
/// and neither the stop nor the turn is published.
#[tokio::test]
async fn a_refused_stop_publishes_nothing() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("refused stop interruption test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        turn.pool
            .get()
            .await?
            .execute(
                "update runtimes set active_lease_id = null where id = $1",
                &[&turn.runtime_id],
            )
            .await?;
        let before = turn.run(turn.run_id).await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");

        assert_eq!(turn.run(turn.run_id).await?, before);
        assert_eq!(turn.job(turn.job_id).await?.0, "leased");
        assert_eq!(turn.releases(), 0);
        assert_publishes_nothing_of_the_stop(&drain(&mut events), &turn);
        Ok(())
    })
    .await
}

/// A repeated Stop finds the runtime already stopped and changes nothing. It
/// announces the same stored record again, with the same timestamp, so a
/// viewer's clock on the waiting turn does not restart, but it stopped no
/// runtime, so it publishes no second `runtime.stopped`.
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
        let published = drain(&mut events);
        let announced = of_kind(&published, "run.progress", turn.run_id);
        assert_eq!(announced.len(), 2, "{announced:?}");
        for event in &announced {
            assert_announces(event, &turn, &first, "user_stop");
        }
        assert_eq!(announced[0].data, announced[1].data);
        assert_eq!(
            of_kind(&published, "runtime.stopped", turn.run_id).len(),
            1,
            "{published:?}"
        );
        Ok(())
    })
    .await
}

/// Remove on a hosted machine, which quarantines like a stop: the removal
/// and the turn are published before the provider release, and the turn is
/// resumed by the next lease.
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

        let (status, body, before_release) = turn
            .post_holding_the_release(
                "/runtime/remove",
                json!({ "runtimeId": turn.runtime_id, "reason": "user_remove" }),
                &mut events,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true, "{body}");
        assert_eq!(turn.releases(), 1);

        let run = turn.assert_interrupted("user_remove").await?;
        assert_publishes_a_persons_stop(
            &before_release,
            &turn,
            &run,
            "user_remove",
            "runtime_remove",
        );
        assert_publishes_nothing_of_the_stop(&drain(&mut events), &turn);

        turn.assert_resumed_by_a_lease().await
    })
    .await
}

/// Taking over the organization's hosted slot from another space stops this
/// space's machine through `/runtime/stop` with `runtime_limit_takeover`, a
/// person's stop like Stop.
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
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn.stop("runtime_limit_takeover").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], true, "{body}");

        let run = turn.assert_interrupted("runtime_limit_takeover").await?;
        assert_publishes_a_persons_stop(
            &drain(&mut events),
            &turn,
            &run,
            "runtime_limit_takeover",
            "runtime_stop",
        );
        turn.assert_resumed_by_a_lease().await
    })
    .await
}

/// A browser session recycles its own space's idle machine with
/// `runtime_limit_takeover` through a stop that spares active jobs, and then
/// starts it again itself. Nobody clicked it, so it publishes no
/// `runtime.stopped` that would hold that space in its other tabs. A turn
/// whose lease lapsed is still requeued and announced.
#[tokio::test]
async fn a_browser_sessions_own_recycle_publishes_no_runtime_stopped() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("browser session recycle stop test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        turn.let_the_runtime_go_quiet().await?;
        let mut events = turn.state.events.subscribe();

        let (status, body) = turn
            .post(
                "/runtime/stop",
                json!({
                    "runtime_id": turn.runtime_id,
                    "reason": "runtime_limit_takeover",
                    "skip_if_active_jobs": true,
                    "expected_project_id": turn.project_id,
                }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], true, "{body}");

        let run = turn.assert_interrupted("runtime_limit_takeover").await?;
        let published = drain(&mut events);
        assert!(
            of_kind(&published, "runtime.stopped", turn.run_id).is_empty(),
            "{published:?}"
        );
        let announced = of_kind(&published, "run.progress", turn.run_id);
        assert_eq!(announced.len(), 1, "{published:?}");
        assert_announces(announced[0], &turn, &run, "runtime_limit_takeover");
        Ok(())
    })
    .await
}

/// A stop through `/runtime/stop` that is not a person's, here a runtime
/// shutting itself down, publishes no `runtime.stopped`: a tab reads a
/// reason it does not know as an unexpected loss and starts the machine
/// again. The turn it interrupted is announced as before.
#[tokio::test]
async fn a_stop_that_is_not_a_persons_publishes_no_runtime_stopped() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("runtime shutdown stop test").await?;
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

        let (status, body) = turn.stop("agent_shutdown").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status_changed"], true, "{body}");

        let run = turn.assert_interrupted("agent_shutdown").await?;
        let published = drain(&mut events);
        assert!(
            of_kind(&published, "runtime.stopped", turn.run_id).is_empty(),
            "{published:?}"
        );
        let announced = of_kind(&published, "run.progress", turn.run_id);
        assert_eq!(announced.len(), 1, "{published:?}");
        assert_announces(announced[0], &turn, &run, "agent_shutdown");
        Ok(())
    })
    .await
}

/// The pool-retirement drain stops a live runtime with its active turn
/// (`/operator/runtime-drain/stop`). It neither announces the turn nor
/// publishes `runtime.stopped`; viewers see the record on their next load of
/// the runs.
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
        assert_publishes_nothing_of_the_stop(&drain(&mut events), &turn);
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

/// An announce that reads the runs after a lease resumed one of the turns
/// publishes nothing for it: it reads only runs still `queued` at
/// `requeued`, so it cannot follow the lease's `in_progress` with a stale
/// `queued`. A turn still waiting in the same space is announced as before.
#[tokio::test]
async fn an_announce_after_a_lease_skips_the_resumed_turn() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("announce after a lease test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(project_id), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let (waiting_job, waiting_run) = insert_turn(
            &pool,
            project_id,
            turn.conversation_id,
            turn.runtime_id,
            "in_progress",
            true,
            json!({}),
        )
        .await?;
        let (status, body) = turn.stop("user_stop").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        turn.assert_interrupted("user_stop").await?;
        let waiting = turn
            .assert_turn_interrupted(waiting_job, waiting_run, "user_stop")
            .await?;
        // The lease takes the older of the two jobs, the turn's.
        turn.assert_resumed_by_a_lease().await?;

        let mut events = turn.state.events.subscribe();
        super::announce_interrupted_runs(&turn.state, &turn.runtime_id).await;

        let mut announced = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.kind == "run.progress" {
                announced.push(event);
            }
        }
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_eq!(announced[0].run_id, Some(waiting_run));
        assert_eq!(announced[0].job_id, Some(waiting_job));
        assert_eq!(announced[0].timestamp, waiting.updated_at);
        assert_eq!(announced[0].data["status"], "queued");
        assert_eq!(turn.run(turn.run_id).await?.status, "in_progress");
        Ok(())
    })
    .await
}
