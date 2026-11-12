//! Goal writes while a teammate writes into the same conversation, on the
//! migrated database.
//!
//! Writing a message into a conversation takes two steps: the insert, which
//! locks the conversation's row the way any row referencing it does
//! (`for key share`), then an update of that row. A goal write that updated
//! the row before locking it for the goal must not wait for a teammate's
//! first step, since the teammate's second step waits for it. Each test holds
//! a teammate between its two steps while the real handler runs: a job's
//! completion, its runtime's goal update and a person's Stop. Both sides
//! finish, the goal changes and the teammate's reply is kept.

use std::future::Future;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde_json::{json, Value};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, require_origin_test_pool,
    spawn_aborting, test_origin_private_key, test_origin_public_key, with_shared_db_fixture,
    SharedDbFixture,
};
use crate::AppState;

/// The hosted provider of the turn's runtime.
const HOSTED_PROVIDER: &str = "instafy-cloud";
const TEAMMATE_REPLY: &str = "Reviewed the API docs.";

fn controller_error(
    context: &str,
    (status, axum::Json(body)): (StatusCode, axum::Json<crate::ApiError>),
) -> anyhow::Error {
    anyhow::anyhow!(
        "{context} failed with status {} and message {}",
        status.as_u16(),
        body.message
    )
}

fn test_config(label: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
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

/// A person's turn on their own AI, leased by a hosted runtime and bound to
/// the active goal of its private conversation, beside a teammate's run in
/// that conversation.
struct GoalTurn {
    org_id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    conversation_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    revision: Uuid,
    teammate_run_id: Uuid,
}

impl GoalTurn {
    fn new() -> Self {
        Self {
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            revision: Uuid::new_v4(),
            teammate_run_id: Uuid::new_v4(),
        }
    }

    async fn seed(&self, pool: &PgPool, label: &str) -> anyhow::Result<()> {
        ensure_test_user(pool, &self.owner_user_id).await?;
        let mut connection = pool.get().await?;
        let seed = connection.transaction().await?;
        seed.execute(
            "insert into organizations (id, slug, name) values ($1, $2, $3)",
            &[&self.org_id, &format!("{label}-{}", self.org_id), &label],
        )
        .await?;
        seed.execute(
            "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
            &[&self.org_id, &self.owner_user_id],
        )
        .await?;
        seed.execute(
            "insert into projects (id, org_id, name, owner_user_id, project_type, status)
             values ($1, $2, $3, $4, 'customer', 'active')",
            &[&self.project_id, &self.org_id, &label, &self.owner_user_id],
        )
        .await?;
        seed.execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at, capabilities
             ) values ($1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), $5)",
            &[
                &self.runtime_id,
                &self.project_id,
                &HOSTED_PROVIDER,
                &format!("goal-turn-{}", self.runtime_id),
                &PgJson(json!({ "agent": true, "origin": true })),
            ],
        )
        .await?;
        let credential_id = Uuid::new_v4();
        seed.execute(
            "insert into user_credentials (
                 id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
             ) values ($1, $2, 'openai_api_key', 'Goal turn credential',
                 'test-nonce', 'test-ciphertext', '{}'::jsonb, false)",
            &[&credential_id, &self.owner_user_id],
        )
        .await?;
        seed.execute(
            "insert into conversations (id, project_id, created_by, metadata, visibility)
             values ($1, $2, $3, $4, 'private')",
            &[
                &self.conversation_id,
                &self.project_id,
                &self.owner_user_id,
                &PgJson(json!({
                    "instafyGoal": {
                        "id": Uuid::new_v4(),
                        "objective": "Document the API",
                        "status": "active"
                    },
                    "_goalController": {
                        "revision": self.revision,
                        "ownerUserId": self.owner_user_id
                    }
                })),
            ],
        )
        .await?;
        let prompt_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        seed.execute(
            "insert into prompts (id, project_id, conversation_id, user_id, prompt_text)
             values ($1, $2, $3, $4, 'Document the API')",
            &[
                &prompt_id,
                &self.project_id,
                &self.conversation_id,
                &self.owner_user_id,
            ],
        )
        .await?;
        seed.execute(
            "insert into runs (id, project_id, conversation_id, prompt_id, run_type, status)
             values ($1, $2, $3, $4, 'prompt', 'in_progress'),
                    ($5, $2, $3, null, 'prompt', 'in_progress')",
            &[
                &run_id,
                &self.project_id,
                &self.conversation_id,
                &prompt_id,
                &self.teammate_run_id,
            ],
        )
        .await?;
        seed.execute(
            "insert into agent_jobs (
                 id, project_id, run_id, prompt_id, conversation_id, status, intent,
                 credential_id, target_runtime_id, payload,
                 leased_by_runtime_id, leased_at, lease_expires_at, lease_attempts
             ) values (
                 $1, $2, $3, $4, $5, 'leased', 'feature', $6, $7, $8,
                 $7, now(), now() + interval '5 minutes', 1
             )",
            &[
                &self.job_id,
                &self.project_id,
                &run_id,
                &prompt_id,
                &self.conversation_id,
                &credential_id,
                &self.runtime_id,
                &PgJson(json!({
                    "project_id": self.project_id,
                    "conversation_id": self.conversation_id,
                    "user_id": self.owner_user_id,
                    "prompt_text": "Document the API",
                    "metadata": {
                        "runtimePreference": { "runtimeId": self.runtime_id },
                        "_controllerGoal": {
                            "revision": self.revision,
                            "ownerUserId": self.owner_user_id,
                            "userTurn": true
                        }
                    }
                })),
            ],
        )
        .await?;
        seed.commit().await?;
        Ok(())
    }

    /// Posts `body` to an agent endpoint as the turn's runtime. The response
    /// must be a success.
    fn as_runtime(
        &self,
        state: &AppState,
        path: &'static str,
        body: Value,
    ) -> impl Future<Output = anyhow::Result<Value>> + Send + 'static {
        let token = crate::auth::issue_agent_token(
            &state.config,
            &self.project_id,
            &self.runtime_id,
            None,
            None,
        );
        let app = crate::agent::router().with_state(state.clone());
        async move {
            let token = token
                .map_err(|error| controller_error("issuing the agent token", error))?
                .token;
            let authorization = format!("Bearer {token}");
            let (status, body) =
                call_router(&app, Some(&authorization), "POST", path.into(), Some(body)).await?;
            anyhow::ensure!(status == StatusCode::OK, "{path} returned {status}: {body}");
            Ok(body)
        }
    }

    /// Stops the turn's job as its person. The response must be a success.
    fn stop_as_person(
        &self,
        state: &AppState,
    ) -> impl Future<Output = anyhow::Result<Value>> + Send + 'static {
        let token = crate::auth::issue_controller_token(&state.config, &self.owner_user_id);
        let app = crate::conversations::router().with_state(state.clone());
        let path = format!("/conversations/{}/stop", self.conversation_id);
        let body = json!({ "jobIds": [self.job_id] });
        async move {
            let token = token
                .map_err(|error| controller_error("issuing the person's token", error))?
                .token;
            let authorization = format!("Bearer {token}");
            let (status, body) =
                call_router(&app, Some(&authorization), "POST", path.clone(), Some(body)).await?;
            anyhow::ensure!(status == StatusCode::OK, "{path} returned {status}: {body}");
            Ok(body)
        }
    }

    /// The conversation's goal, or null, and its controller revision.
    async fn goal(&self, pool: &PgPool) -> anyhow::Result<(Value, Option<String>)> {
        let row = pool
            .get()
            .await?
            .query_one(
                "select coalesce(metadata -> 'instafyGoal', 'null'::jsonb),
                        metadata #>> '{_goalController,revision}'
                 from conversations where id = $1",
                &[&self.conversation_id],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    async fn job_status(&self, pool: &PgPool) -> anyhow::Result<String> {
        Ok(pool
            .get()
            .await?
            .query_one(
                "select status from agent_jobs where id = $1",
                &[&self.job_id],
            )
            .await?
            .get(0))
    }
}

/// Runs a test body on a seeded turn, then deletes its org, its space and its
/// person however the body ends, a panic included.
async fn with_goal_turn<F, Fut>(label: &str, body: F) -> anyhow::Result<()>
where
    F: FnOnce(PgPool, AppState, GoalTurn) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    use futures_util::FutureExt;

    let pool = require_origin_test_pool(label).await?;
    let turn = GoalTurn::new();
    let fixture = SharedDbFixture {
        organizations: vec![turn.org_id],
        projects: vec![turn.project_id],
    };
    let owner_user_id = turn.owner_user_id;
    let state = build_test_state(pool.clone(), test_config(label));
    let body_pool = pool.clone();
    let outcome = std::panic::AssertUnwindSafe(with_shared_db_fixture(fixture, async move {
        turn.seed(&body_pool, label).await?;
        body(body_pool, state, turn).await
    }))
    .catch_unwind()
    .await;
    // Never `?` here: a failed delete must not replace the body's panic.
    let user_cleanup = async {
        pool.get()
            .await?
            .execute("delete from auth.users where id = $1", &[&owner_user_id])
            .await?;
        anyhow::Ok(())
    }
    .await;
    match outcome {
        Ok(result) => result.and(user_cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// Runs `writer` beside a teammate writing into the turn's conversation, and
/// returns what `writer` returned once both are done.
///
/// The teammate's usage row goes in first, so its transaction holds the lock
/// that inserting a row referencing the conversation takes. Its reply, which
/// also updates the conversation, follows once `writer` has finished or waits
/// on the teammate, and then the teammate commits. The reply must go in and
/// be kept.
async fn beside_a_teammate_writing<T: Send + 'static>(
    pool: &PgPool,
    turn: &GoalTurn,
    writer: impl Future<Output = anyhow::Result<T>> + Send + 'static,
) -> anyhow::Result<T> {
    let (mut teammate, connection) =
        tokio_postgres::connect(&std::env::var("TEST_DATABASE_URL")?, tokio_postgres::NoTls)
            .await?;
    let teammate_driver = tokio::spawn(connection);
    let teammate_pid: i32 = teammate
        .query_one("select pg_backend_pid()", &[])
        .await?
        .get(0);
    let write = teammate.transaction().await?;
    crate::agent::insert_agent_conversation_message(
        &write,
        &turn.project_id,
        &turn.conversation_id,
        None,
        None,
        Some(turn.teammate_run_id),
        "Token usage — input: 10, cached: 0, output: 5".to_string(),
        json!({ "messageType": "token_usage" }),
        false,
        false,
    )
    .await
    .map_err(|error| controller_error("writing the teammate's usage row", error))?;

    // Aborted if this returns early, so it never outlives the fixture.
    let writing = spawn_aborting(writer);
    // Until the writer has finished or waits on the teammate.
    let observer = pool.get().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !writing.is_finished() && Instant::now() < deadline {
        let waits_on_the_teammate: bool = observer
            .query_one(
                "select exists(select 1 from pg_stat_activity
                 where $1 = any(pg_blocking_pids(pid)))",
                &[&teammate_pid],
            )
            .await?
            .get(0);
        if waits_on_the_teammate {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    drop(observer);
    let reply = crate::agent::insert_agent_conversation_message(
        &write,
        &turn.project_id,
        &turn.conversation_id,
        None,
        None,
        Some(turn.teammate_run_id),
        TEAMMATE_REPLY.to_string(),
        json!({}),
        false,
        true,
    )
    .await;
    let written = match reply {
        Ok(_) => write.commit().await.map_err(|error| error.to_string()),
        Err(error) => {
            let _ = write.rollback().await;
            Err(controller_error("writing the teammate's reply", error).to_string())
        }
    };
    let outcome = tokio::time::timeout(Duration::from_secs(20), writing).await??;
    drop(teammate);
    let _ = teammate_driver.await;
    assert_eq!(written, Ok(()), "the teammate's reply");
    let replies: i64 = pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages
             where conversation_id = $1 and content = $2",
            &[&turn.conversation_id, &TEAMMATE_REPLY],
        )
        .await?
        .get(0);
    assert_eq!(replies, 1, "the teammate's reply is kept");
    outcome
}

/// A job's completion writes its reply into the conversation, then settles
/// the goal its turn was sent for: a failed run blocks it.
#[tokio::test]
async fn a_job_completion_settles_its_goal_beside_a_teammate_writing() -> anyhow::Result<()> {
    with_goal_turn(
        "goal-completion-beside-a-teammate",
        |pool, state, turn| async move {
            let completing = turn.as_runtime(
                &state,
                "/agent/complete",
                json!({
                    "job_id": turn.job_id.to_string(),
                    "outcome": "failed",
                    "error_message": "The docs build failed.",
                }),
            );
            beside_a_teammate_writing(&pool, &turn, completing)
                .await
                .map_err(|error| error.context("the job's completion"))?;
            let (goal, revision) = turn.goal(&pool).await?;
            assert_eq!(goal["status"], "blocked");
            assert_eq!(goal["progressSummary"], "The goal run failed.");
            assert_eq!(revision, Some(turn.revision.to_string()));
            assert_eq!(turn.job_status(&pool).await?, "failed");
            Ok(())
        },
    )
    .await
}

/// A runtime's goal update is written into the conversation as a message,
/// then applied to the goal its turn was sent for.
#[tokio::test]
async fn a_goal_update_lands_beside_a_teammate_writing() -> anyhow::Result<()> {
    with_goal_turn(
        "goal-update-beside-a-teammate",
        |pool, state, turn| async move {
            let updating = turn.as_runtime(
                &state,
                "/agent/message",
                json!({
                    "job_id": turn.job_id.to_string(),
                    "content": "Checked the API reference.",
                    "message_type": "goal_update",
                    "metadata": { "progressSummary": "The API reference is checked" },
                }),
            );
            beside_a_teammate_writing(&pool, &turn, updating)
                .await
                .map_err(|error| error.context("the runtime's goal update"))?;
            let (goal, revision) = turn.goal(&pool).await?;
            assert_eq!(goal["status"], "active");
            assert_eq!(goal["progressSummary"], "The API reference is checked");
            assert_eq!(revision, Some(turn.revision.to_string()));
            assert_eq!(turn.job_status(&pool).await?, "leased");
            Ok(())
        },
    )
    .await
}

/// A person's Stop cancels the turn and writes its notice into the
/// conversation, then pauses the goal the turn was sent for.
#[tokio::test]
async fn a_stop_pauses_its_goal_beside_a_teammate_writing() -> anyhow::Result<()> {
    with_goal_turn(
        "goal-stop-beside-a-teammate",
        |pool, state, turn| async move {
            let stopping = turn.stop_as_person(&state);
            let stopped = beside_a_teammate_writing(&pool, &turn, stopping)
                .await
                .map_err(|error| error.context("the person's Stop"))?;
            assert_eq!(stopped["canceledJobIds"], json!([turn.job_id]));
            let (goal, revision) = turn.goal(&pool).await?;
            assert_eq!(goal["status"], "paused");
            assert_eq!(goal["updatedBy"], json!(turn.owner_user_id));
            assert!(revision.is_some());
            assert_ne!(revision, Some(turn.revision.to_string()));
            assert_eq!(turn.job_status(&pool).await?, "canceled");
            let notices: i64 = pool
                .get()
                .await?
                .query_one(
                    "select count(*) from conversation_messages
                     where conversation_id = $1 and content = 'Stopped this run.'",
                    &[&turn.conversation_id],
                )
                .await?
                .get(0);
            assert_eq!(notices, 1, "the Stop's notice");
            Ok(())
        },
    )
    .await
}
