//! The goal recovery sweep beside other writers, on the migrated database.
//!
//! A message written into a thread updates the thread and then its root. A
//! sweep that settled a root's goal and then, in the same transaction, waited
//! for one of the root's threads deadlocked with a teammate writing into that
//! thread. The first test runs the sweep while a teammate is writing into a
//! second root, then has another teammate write into the first root's thread.
//! Both messages are kept, and the sweep leaves the busy conversation for its
//! next tick instead of waiting for it.
//!
//! A team delete removes a space's conversations and then their jobs. A sweep
//! that held one of those jobs while it waited for the job's conversation
//! would deadlock with it. The second test stops a team delete between the two
//! while the sweep tries to settle one of the jobs. The sweep leaves the job
//! and the team is deleted. The third holds a job, as a Stop or a cancel of it
//! does while it works, and the sweep settles the others without waiting for
//! it. The fourth makes the first job fail to settle, and the sweep still
//! settles the jobs after it.
//!
//! A tick takes sixteen jobs, the ones that ended first. A job the sweep
//! leaves unsettled stays a candidate, so sixteen of them kept every later
//! job, in every space, from being settled. The fifth test puts sixteen jobs
//! whose goals the sweep may never settle ahead of the others, and the sixth
//! sixteen that fail to settle on every try. The jobs behind them are settled
//! within two ticks all the same, and the failed ones once they stop failing.

use std::future::Future;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use futures_util::FutureExt;
use serde_json::json;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::config::PgPool;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool, spawn_aborting,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, AbortingTask,
    SharedDbFixture,
};
use crate::AppState;

const THREAD_REPLY: &str = "Reviewed the thread's API notes.";
const HELD_REPLY: &str = "Checked the release notes.";

// The sweep is global. Keep the goals of separate tests from being settled by
// one another's sweeps.
static GOAL_SWEEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

/// Why the sweep cannot settle the goal of a stuck conversation's job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stuck {
    /// The goal has no id. A metadata update stores a goal as it is sent.
    GoalWithoutId,
    /// The job is a person's own turn that says it is a team's worker.
    WorkerTurn,
    /// The person who set the goal was deleted, which leaves their prompts
    /// naming no one.
    OwnerDeleted,
    /// An ordinary goal, whose writes the test makes fail.
    FailsToSettle,
}

/// A space with a root conversation, a second root and a thread of the first
/// root, in the order their goals' jobs ended, after the jobs of any stuck
/// conversations. Each conversation has an active goal whose job was canceled
/// without settling it, which leaves the goal to the sweep. A space in a team
/// is marked deleted, as a team delete first marks its spaces and cancels
/// their jobs.
struct EndedGoals {
    team_id: Option<Uuid>,
    project_id: Uuid,
    owner_user_id: Uuid,
    root: Uuid,
    held: Uuid,
    thread: Uuid,
    stuck: Vec<(Uuid, Stuck)>,
}

impl EndedGoals {
    fn new() -> Self {
        Self {
            team_id: None,
            project_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            root: Uuid::new_v4(),
            held: Uuid::new_v4(),
            thread: Uuid::new_v4(),
            stuck: Vec::new(),
        }
    }

    fn in_deleted_team() -> Self {
        Self {
            team_id: Some(Uuid::new_v4()),
            ..Self::new()
        }
    }

    /// Behind a stuck conversation for each of `stuck`, whose jobs ended
    /// first.
    fn behind(stuck: impl IntoIterator<Item = Stuck>) -> Self {
        Self {
            stuck: stuck
                .into_iter()
                .map(|stuck| (Uuid::new_v4(), stuck))
                .collect(),
            ..Self::new()
        }
    }

    async fn seed(&self, pool: &PgPool, label: &str) -> anyhow::Result<()> {
        ensure_test_user(pool, &self.owner_user_id).await?;
        let mut connection = pool.get().await?;
        let seed = connection.transaction().await?;
        if let Some(team_id) = self.team_id {
            seed.execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&team_id, &format!("goal-sweep-{team_id}"), &label],
            )
            .await?;
        }
        seed.execute(
            "insert into projects (id, name, owner_user_id, project_type, status, org_id)
             values ($1, $2, $3, 'customer', 'active', $4)",
            &[&self.project_id, &label, &self.owner_user_id, &self.team_id],
        )
        .await?;
        let stuck = self
            .stuck
            .iter()
            .map(|&(conversation, stuck)| (conversation, None, Some(stuck)));
        let conversations = stuck.chain([
            (self.root, None, None),
            (self.held, None, None),
            (self.thread, Some(self.root), None),
        ]);
        for (ended, (conversation, root, stuck)) in (0_i32..).zip(conversations) {
            let revision = Uuid::new_v4();
            // Deleting a person sets their prompts' user to null, and their
            // goal still names them.
            let owner_deleted = stuck == Some(Stuck::OwnerDeleted);
            let goal_owner = if owner_deleted {
                Uuid::new_v4()
            } else {
                self.owner_user_id
            };
            let goal = if stuck == Some(Stuck::GoalWithoutId) {
                json!({"objective": "Document the API", "status": "active"})
            } else {
                json!({
                    "id": Uuid::new_v4(),
                    "objective": "Document the API",
                    "status": "active"
                })
            };
            seed.execute(
                "insert into conversations (
                     id, project_id, created_by, metadata, visibility,
                     parent_conversation_id, root_conversation_id
                 ) values ($1, $2, $3, $4, 'private', $5, $5)",
                &[
                    &conversation,
                    &self.project_id,
                    &self.owner_user_id,
                    &PgJson(json!({
                        "instafyGoal": goal,
                        "_goalController": {
                            "revision": revision,
                            "ownerUserId": goal_owner
                        }
                    })),
                    &root,
                ],
            )
            .await?;
            let prompt_id = Uuid::new_v4();
            seed.execute(
                "insert into prompts (id, project_id, conversation_id, user_id, prompt_text)
                 values ($1, $2, $3, $4, 'Document the API')",
                &[
                    &prompt_id,
                    &self.project_id,
                    &conversation,
                    &(!owner_deleted).then_some(self.owner_user_id),
                ],
            )
            .await?;
            let mut metadata = json!({
                "_controllerGoal": {
                    "revision": revision,
                    "ownerUserId": goal_owner
                }
            });
            // Dispatch takes a job's role from the plan its turn names.
            let role = (stuck == Some(Stuck::WorkerTurn)).then_some("worker");
            if let Some(role) = role {
                metadata["multiAgentPlan"] = json!({"role": role, "groupId": Uuid::new_v4()});
            }
            // Ended long before any other job, so the sweep takes these first,
            // in this order.
            seed.execute(
                "insert into agent_jobs (
                     id, project_id, prompt_id, conversation_id, status, outcome,
                     intent, payload, agent_role, completed_at
                 ) values (
                     $1, $2, $3, $4, 'canceled', 'canceled', 'feature', $5, $6,
                     timestamptz '2000-01-01 00:00:00+00' + $7::int * interval '1 second'
                 )",
                &[
                    &Uuid::new_v4(),
                    &self.project_id,
                    &prompt_id,
                    &conversation,
                    &PgJson(json!({
                        "project_id": self.project_id,
                        "conversation_id": conversation,
                        "user_id": self.owner_user_id,
                        "prompt_text": "Document the API",
                        "metadata": metadata
                    })),
                    &role,
                    &ended,
                ],
            )
            .await?;
        }
        if self.team_id.is_some() {
            seed.execute(
                "update projects set status = 'deleted' where id = $1",
                &[&self.project_id],
            )
            .await?;
        }
        seed.commit().await?;
        Ok(())
    }

    async fn goal_status(&self, pool: &PgPool, conversation: Uuid) -> anyhow::Result<String> {
        Ok(pool
            .get()
            .await?
            .query_one(
                "select coalesce(metadata #>> '{instafyGoal,status}', 'none')
                 from conversations where id = $1",
                &[&conversation],
            )
            .await?
            .get(0))
    }

    /// The job of `conversation`, with its prompt.
    async fn job(&self, pool: &PgPool, conversation: Uuid) -> anyhow::Result<(Uuid, Uuid)> {
        let row = pool
            .get()
            .await?
            .query_one(
                "select id, prompt_id from agent_jobs where conversation_id = $1",
                &[&conversation],
            )
            .await?;
        Ok((row.get("id"), row.get("prompt_id")))
    }
}

/// Seeds `goals`, runs a test body on them, then deletes their space, their
/// team and their person however the body ends, a panic included.
async fn with_ended_goals<F, Fut>(label: &str, goals: EndedGoals, body: F) -> anyhow::Result<()>
where
    F: FnOnce(PgPool, AppState, EndedGoals) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let _guard = GOAL_SWEEP.lock().await;
    let pool = require_origin_test_pool(label).await?;
    let fixture = SharedDbFixture {
        organizations: goals.team_id.into_iter().collect(),
        projects: vec![goals.project_id],
    };
    let owner_user_id = goals.owner_user_id;
    let config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    let state = build_test_state(pool.clone(), config);
    let body_pool = pool.clone();
    let outcome = std::panic::AssertUnwindSafe(with_shared_db_fixture(fixture, async move {
        goals.seed(&body_pool, label).await?;
        body(body_pool, state, goals).await
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

/// A connection of its own, its driver and its backend's pid.
async fn own_connection() -> anyhow::Result<(
    tokio_postgres::Client,
    tokio::task::JoinHandle<Result<(), tokio_postgres::Error>>,
    i32,
)> {
    let (client, connection) =
        tokio_postgres::connect(&std::env::var("TEST_DATABASE_URL")?, tokio_postgres::NoTls)
            .await?;
    let driver = tokio::spawn(connection);
    let pid: i32 = client
        .query_one("select pg_backend_pid()", &[])
        .await?
        .get(0);
    Ok((client, driver, pid))
}

/// Polls `condition`, a query on `pid` that returns whether a backend waits,
/// until it does or `task` has finished, for at most ten seconds. Returns
/// whether it was seen to wait.
async fn seen_waiting<T>(
    pool: &PgPool,
    task: &AbortingTask<T>,
    condition: &str,
    pid: i32,
) -> anyhow::Result<bool> {
    let observer = pool.get().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !task.is_finished() && Instant::now() < deadline {
        if observer.query_one(condition, &[&pid]).await?.get(0) {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(false)
}

/// Some backend waits for `pid`.
const WAITS_FOR: &str =
    "select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)))";
/// The backend `pid` waits for another.
const WAITS: &str = "select cardinality(pg_blocking_pids($1)) > 0";

/// Whether locking the row `id` of `table` `for {lock}` would wait for another
/// transaction, found out without waiting. A delete or a `for update` makes
/// `key share` wait, and any update makes `share` wait too.
async fn would_wait(pool: &PgPool, table: &str, id: Uuid, lock: &str) -> anyhow::Result<bool> {
    let mut connection = pool.get().await?;
    let probe = connection.transaction().await?;
    let sql = format!("select 1 from {table} where id = $1 for {lock} nowait");
    let waits = match probe.query_opt(sql.as_str(), &[&id]).await {
        Ok(_) => false,
        Err(error) if error.code() == Some(&SqlState::LOCK_NOT_AVAILABLE) => true,
        Err(error) => return Err(error.into()),
    };
    // Before it returns, so the probe holds nothing afterwards.
    probe.rollback().await?;
    Ok(waits)
}

/// A trigger that rejects every write of the goals of some conversations, so
/// their jobs fail to settle, and a sequence that counts the writes it
/// rejected, which a rollback does not undo.
struct GoalWriteFailure {
    name: String,
}

impl GoalWriteFailure {
    async fn inject(pool: &PgPool, conversations: &[Uuid]) -> anyhow::Result<Self> {
        let name = format!("fail_goal_sweep_{}", Uuid::new_v4().simple());
        let ids = conversations
            .iter()
            .map(|conversation| format!("'{conversation}'"))
            .collect::<Vec<_>>()
            .join(", ");
        pool.get()
            .await?
            .batch_execute(&format!(
                "create sequence {name};
                 create function {name}() returns trigger language plpgsql as $fn$
                 begin
                     perform nextval('{name}');
                     raise exception 'injected failure in a goal write';
                 end
                 $fn$;
                 create trigger {name} before update on conversations
                     for each row when (new.id in ({ids})) execute function {name}();"
            ))
            .await?;
        Ok(Self { name })
    }

    /// Removes the trigger, and gives the number of writes it rejected.
    async fn remove(self, pool: &PgPool) -> anyhow::Result<i64> {
        let name = self.name;
        let connection = pool.get().await?;
        let count = format!("select case when is_called then last_value else 0 end from {name}");
        let rejected = connection.query_one(count.as_str(), &[]).await;
        connection
            .batch_execute(&format!(
                "drop trigger {name} on conversations;
                 drop function {name}();
                 drop sequence {name};"
            ))
            .await?;
        Ok(rejected?.get::<_, i64>(0))
    }
}

#[tokio::test]
async fn the_sweep_and_a_teammate_writing_into_a_thread_both_finish() -> anyhow::Result<()> {
    with_ended_goals(
        "goal sweep beside a thread writer",
        EndedGoals::new(),
        |pool, state, goals| async move {
            // A teammate is writing into the second root. A sweep that kept
            // the root's lock would stop there, after the root and before the
            // thread.
            let (mut holder, holder_driver, holder_pid) = own_connection().await?;
            let hold = holder.transaction().await?;
            crate::agent::insert_agent_conversation_message(
                &hold,
                &goals.project_id,
                &goals.held,
                None,
                None,
                None,
                HELD_REPLY.to_string(),
                json!({}),
                false,
                true,
            )
            .await
            .map_err(|error| controller_error("writing into the second root", error))?;
            let sweep_state = state.clone();
            // Aborted if this returns early, so it never outlives the fixture.
            let sweeping =
                spawn_aborting(async move { super::settle_ended_jobs(&sweep_state).await });
            // Until the sweep has finished or waits for the teammate.
            let waited = seen_waiting(&pool, &sweeping, WAITS_FOR, holder_pid).await?;

            // Meanwhile a teammate writes into the root's thread: the message,
            // then the thread's update, then the root's.
            let (writer, writer_driver, writer_pid) = own_connection().await?;
            let (project_id, thread) = (goals.project_id, goals.thread);
            let writing = spawn_aborting(async move {
                let mut writer = writer;
                let write = writer.transaction().await?;
                crate::agent::insert_agent_conversation_message(
                    &write,
                    &project_id,
                    &thread,
                    None,
                    None,
                    None,
                    THREAD_REPLY.to_string(),
                    json!({}),
                    false,
                    true,
                )
                .await
                .map_err(|error| controller_error("writing into the thread", error))?;
                write.commit().await?;
                anyhow::Ok(())
            });
            // Until it has written or waits, then the second root's teammate
            // finishes.
            seen_waiting(&pool, &writing, WAITS, writer_pid).await?;
            hold.commit().await?;

            let written = tokio::time::timeout(Duration::from_secs(20), writing).await??;
            let swept = tokio::time::timeout(Duration::from_secs(20), sweeping).await??;
            drop(holder);
            let _ = holder_driver.await;
            let _ = writer_driver.await;
            written?;
            swept.map_err(|error| controller_error("the goal sweep", error))?;
            assert!(
                !waited,
                "the sweep does not wait for a conversation a teammate is writing into"
            );
            for conversation in [goals.root, goals.thread] {
                assert_eq!(
                    goals.goal_status(&pool, conversation).await?,
                    "canceled",
                    "the free goals are settled"
                );
            }
            assert_eq!(
                goals.goal_status(&pool, goals.held).await?,
                "active",
                "the busy conversation is left for the next tick"
            );
            super::settle_ended_jobs(&state)
                .await
                .map_err(|error| controller_error("the next goal sweep", error))?;
            assert_eq!(
                goals.goal_status(&pool, goals.held).await?,
                "canceled",
                "the next tick settles it"
            );
            let kept: i64 = pool
                .get()
                .await?
                .query_one(
                    "select count(*) from conversation_messages
                     where (conversation_id = $1 and content = $2)
                        or (conversation_id = $3 and content = $4)",
                    &[&goals.thread, &THREAD_REPLY, &goals.held, &HELD_REPLY],
                )
                .await?
                .get(0);
            assert_eq!(kept, 2, "both teammates' messages are kept");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn the_sweep_and_a_team_delete_of_its_space_both_finish() -> anyhow::Result<()> {
    with_ended_goals(
        "goal sweep beside a team delete",
        EndedGoals::in_deleted_team(),
        |pool, state, goals| async move {
            let team_id = goals
                .team_id
                .ok_or_else(|| anyhow::anyhow!("the goals are in a team"))?;
            let (job_id, prompt_id) = goals.job(&pool, goals.root).await?;
            // A transaction holds the root's prompt, as one writing a row for
            // that prompt does until it commits. A team delete removes a
            // space's conversations, then its prompts, then its jobs, so it
            // stops there with the conversations removed and the jobs not yet.
            let (mut holder, holder_driver, holder_pid) = own_connection().await?;
            let hold = holder.transaction().await?;
            hold.execute(
                "select 1 from prompts where id = $1 for key share",
                &[&prompt_id],
            )
            .await?;
            let deleting = spawn_aborting(async move {
                crate::organization_deletion::delete_released_team(&state, &team_id).await
            });
            anyhow::ensure!(
                seen_waiting(&pool, &deleting, WAITS_FOR, holder_pid).await?,
                "the team delete never reached the root's prompt"
            );
            // A sweep that held the job while it waited for the conversation
            // deadlocks only in this order, so check it rather than assume it.
            anyhow::ensure!(
                would_wait(&pool, "conversations", goals.root, "key share").await?,
                "the team delete has removed the root conversation"
            );
            anyhow::ensure!(
                !would_wait(&pool, "agent_jobs", job_id, "share").await?,
                "the team delete has not reached the root's job"
            );

            // Meanwhile the sweep tries to settle the root's job.
            let (mut sweeper, sweeper_driver, sweeper_pid) = own_connection().await?;
            let sweeping =
                spawn_aborting(async move { super::settle_ended_job(&mut sweeper, job_id).await });
            // Until the sweep has finished or waits.
            let waited = seen_waiting(&pool, &sweeping, WAITS, sweeper_pid).await?;
            hold.commit().await?;

            let deleted = tokio::time::timeout(Duration::from_secs(20), deleting).await??;
            let swept = tokio::time::timeout(Duration::from_secs(20), sweeping).await??;
            drop(holder);
            let _ = holder_driver.await;
            let _ = sweeper_driver.await;
            assert!(
                deleted.map_err(|error| controller_error("the team delete", error))?,
                "the team is deleted"
            );
            assert!(
                swept
                    .map_err(|error| controller_error("the goal sweep", error))?
                    .is_none(),
                "the sweep leaves the job whose conversation the team delete holds"
            );
            assert!(!waited, "the sweep does not wait for the team delete");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn the_sweep_leaves_a_job_another_transaction_holds_for_the_next_tick() -> anyhow::Result<()>
{
    with_ended_goals(
        "goal sweep beside a held job",
        EndedGoals::new(),
        |pool, state, goals| async move {
            // A Stop or a cancel of the thread's job holds it while it works.
            // The sweep goes on without it rather than wait.
            let (job_id, _) = goals.job(&pool, goals.thread).await?;
            let (mut holder, holder_driver, holder_pid) = own_connection().await?;
            let hold = holder.transaction().await?;
            hold.execute(
                "select 1 from agent_jobs where id = $1 for update",
                &[&job_id],
            )
            .await?;
            let sweep_state = state.clone();
            let sweeping =
                spawn_aborting(async move { super::settle_ended_jobs(&sweep_state).await });
            // Until the sweep has finished or waits for the held job.
            let waited = seen_waiting(&pool, &sweeping, WAITS_FOR, holder_pid).await?;
            hold.commit().await?;

            let swept = tokio::time::timeout(Duration::from_secs(20), sweeping).await??;
            drop(holder);
            let _ = holder_driver.await;
            swept.map_err(|error| controller_error("the goal sweep", error))?;
            assert!(
                !waited,
                "the sweep does not wait for a job another transaction holds"
            );
            for conversation in [goals.root, goals.held] {
                assert_eq!(
                    goals.goal_status(&pool, conversation).await?,
                    "canceled",
                    "the free goals are settled"
                );
            }
            assert_eq!(
                goals.goal_status(&pool, goals.thread).await?,
                "active",
                "the held job is left for the next tick"
            );
            super::settle_ended_jobs(&state)
                .await
                .map_err(|error| controller_error("the next goal sweep", error))?;
            assert_eq!(
                goals.goal_status(&pool, goals.thread).await?,
                "canceled",
                "the next tick settles it"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn the_sweep_goes_on_past_a_job_that_fails_to_settle() -> anyhow::Result<()> {
    with_ended_goals(
        "goal sweep past a failed job",
        EndedGoals::new(),
        |pool, state, goals| async move {
            // The root's goal cannot be written while this is in place, so the
            // first job fails to settle.
            let failure = GoalWriteFailure::inject(&pool, &[goals.root]).await?;
            let swept = std::panic::AssertUnwindSafe(super::settle_ended_jobs(&state))
                .catch_unwind()
                .await;
            // Removed however the sweep ended, a panic included.
            let removed = failure.remove(&pool).await;
            let swept = swept.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
            let rejected = removed?;

            swept.map_err(|error| controller_error("the goal sweep", error))?;
            assert_eq!(rejected, 1, "the root's goal write was rejected once");
            assert_eq!(
                goals.goal_status(&pool, goals.root).await?,
                "active",
                "the failed job is left for the next tick"
            );
            for conversation in [goals.held, goals.thread] {
                assert_eq!(
                    goals.goal_status(&pool, conversation).await?,
                    "canceled",
                    "the jobs after it are settled"
                );
            }
            super::settle_ended_jobs(&state)
                .await
                .map_err(|error| controller_error("the next goal sweep", error))?;
            assert_eq!(
                goals.goal_status(&pool, goals.root).await?,
                "canceled",
                "the next tick settles it"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn the_sweep_gets_past_jobs_whose_goals_it_cannot_settle() -> anyhow::Result<()> {
    // A tick's worth, sixteen, of the ways a goal is left to a sweep that may
    // not settle it.
    let stuck = [Stuck::GoalWithoutId, Stuck::WorkerTurn, Stuck::OwnerDeleted]
        .into_iter()
        .cycle()
        .take(16);
    with_ended_goals(
        "goal sweep behind goals it cannot settle",
        EndedGoals::behind(stuck),
        |pool, state, goals| async move {
            for tick in ["the goal sweep", "the next goal sweep"] {
                super::settle_ended_jobs(&state)
                    .await
                    .map_err(|error| controller_error(tick, error))?;
            }
            for conversation in [goals.root, goals.held, goals.thread] {
                assert_eq!(
                    goals.goal_status(&pool, conversation).await?,
                    "canceled",
                    "the goals behind the stuck ones are settled"
                );
            }
            for &(conversation, stuck) in &goals.stuck {
                assert_eq!(
                    goals.goal_status(&pool, conversation).await?,
                    "active",
                    "the sweep leaves a goal it cannot settle ({stuck:?}) as it is"
                );
            }
            let mut recorded: Vec<Uuid> = pool
                .get()
                .await?
                .query(
                    "select j.conversation_id from conversation_goal_recovery_checks r
                     join agent_jobs j on j.id = r.job_id
                     where j.project_id = $1",
                    &[&goals.project_id],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect();
            let mut left: Vec<Uuid> = goals
                .stuck
                .iter()
                .map(|&(conversation, _)| conversation)
                .collect();
            recorded.sort();
            left.sort();
            assert_eq!(
                recorded, left,
                "the sweep records the jobs it left unsettled, and no others"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn the_sweep_gets_past_jobs_that_keep_failing_to_settle() -> anyhow::Result<()> {
    with_ended_goals(
        "goal sweep behind jobs that fail to settle",
        EndedGoals::behind([Stuck::FailsToSettle; 16]),
        |pool, state, goals| async move {
            let failing: Vec<Uuid> = goals
                .stuck
                .iter()
                .map(|&(conversation, _)| conversation)
                .collect();
            let failure = GoalWriteFailure::inject(&pool, &failing).await?;
            let swept = std::panic::AssertUnwindSafe(async {
                super::settle_ended_jobs(&state).await?;
                super::settle_ended_jobs(&state).await
            })
            .catch_unwind()
            .await;
            // Removed however the sweeps ended, a panic included.
            let removed = failure.remove(&pool).await;
            let swept = swept.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
            let rejected = removed?;

            swept.map_err(|error| controller_error("the goal sweeps", error))?;
            assert!(
                rejected >= 16,
                "the failing jobs' goal writes were rejected, {rejected} times"
            );
            for conversation in [goals.root, goals.held, goals.thread] {
                assert_eq!(
                    goals.goal_status(&pool, conversation).await?,
                    "canceled",
                    "the goals behind the failing ones are settled"
                );
            }
            super::settle_ended_jobs(&state)
                .await
                .map_err(|error| controller_error("the goal sweep after the failures", error))?;
            for conversation in failing {
                assert_eq!(
                    goals.goal_status(&pool, conversation).await?,
                    "canceled",
                    "a job that failed to settle is tried again"
                );
            }
            Ok(())
        },
    )
    .await
}
