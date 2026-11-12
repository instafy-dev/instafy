#![cfg(test)]

//! Watching lock waits on the migrated database, for tests of transactions
//! that lock rows in an order: a connection of its own, whose backend's waits
//! show in `pg_blocking_pids`, a probe of whether a row is locked, and the
//! writers such a transaction meets, each held partway: teammates writing
//! into threads, held between their two conversation locks
//! ([`beside_thread_writers`]), a managed-AI dispatch held at its fence
//! ([`DispatchFence`]), and a message naming a run held before it updates
//! its conversation ([`HeldRunMessage`]).
//!
//! A message written into a thread updates the thread, then its root
//! (`crate::agent::insert_agent_conversation_message`). A transaction that
//! writes into several conversations must not wait for a thread while it
//! holds that thread's root: the thread's writer holds the thread and waits
//! for the root, and Postgres ends one of the two as a deadlock.
//! [`beside_thread_writers`] runs such a transaction beside a writer into each
//! of two threads of one root, both held between the two locks, and lets them
//! go one at a time. Whichever thread the transaction takes first, it reaches
//! the second after it wrote into the first.

use std::future::Future;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use futures_util::FutureExt;
use serde_json::json;
use tokio::task::JoinHandle;
use tokio_postgres::error::SqlState;
use uuid::Uuid;

use crate::config::PgPool;
use crate::tests::{spawn_aborting, AbortingTask};

/// What each teammate writes into its thread.
const THREAD_REPLY: &str = "Checked the thread's notes.";

/// How long a transaction under test, or a teammate, may take to finish once
/// nothing holds it.
const FINISH_WITHIN: Duration = Duration::from_secs(20);

pub(crate) type Driver = JoinHandle<Result<(), tokio_postgres::Error>>;

pub(crate) fn controller_error(
    context: &str,
    (status, axum::Json(body)): (StatusCode, axum::Json<crate::ApiError>),
) -> anyhow::Error {
    anyhow::anyhow!(
        "{context} failed with status {} and message {}",
        status.as_u16(),
        body.message
    )
}

/// A connection of its own, its driver and its backend's pid.
pub(crate) async fn own_connection() -> anyhow::Result<(tokio_postgres::Client, Driver, i32)> {
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

/// Polls whether some backend waits for the backend `pid`, until one does or
/// `task` has finished, for at most ten seconds. Returns whether one was seen
/// to wait.
pub(crate) async fn seen_waited_for<T>(
    pool: &PgPool,
    task: &AbortingTask<T>,
    pid: i32,
) -> anyhow::Result<bool> {
    let observer = pool.get().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !task.is_finished() && Instant::now() < deadline {
        if observer
            .query_one(
                "select exists(select 1 from pg_stat_activity
                                where $1 = any(pg_blocking_pids(pid)))",
                &[&pid],
            )
            .await?
            .get(0)
        {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(false)
}

/// Whether locking the row of `table` whose `column` is `id` `for {lock}`
/// would wait for another transaction, found out without waiting. Any update
/// or row lock but `key share` makes `share` wait.
pub(crate) async fn would_wait(
    pool: &PgPool,
    table: &str,
    column: &str,
    id: Uuid,
    lock: &str,
) -> anyhow::Result<bool> {
    let mut connection = pool.get().await?;
    let probe = connection.transaction().await?;
    let sql = format!("select 1 from {table} where {column} = $1 for {lock} nowait");
    let waits = match probe.query_opt(sql.as_str(), &[&id]).await {
        Ok(_) => false,
        Err(error) if error.code() == Some(&SqlState::LOCK_NOT_AVAILABLE) => true,
        Err(error) => return Err(error.into()),
    };
    // Before it returns, so the probe holds nothing afterwards.
    probe.rollback().await?;
    Ok(waits)
}

/// A teammate writing into a thread, on a connection of its own.
struct ThreadWriter {
    thread: Uuid,
    pid: i32,
    writing: AbortingTask<anyhow::Result<()>>,
    driver: Driver,
}

/// Runs `transaction`, which writes into each of `threads`, two threads of
/// `root`, beside a teammate writing a reply into each thread, and returns
/// what `transaction` returned once all three are done.
///
/// Each teammate is held after it updated its thread and before it updates
/// the root: an `after update` trigger on the threads makes the teammate's
/// backend wait for an advisory lock the test holds. Once `transaction` waits
/// for one of them, that one goes and commits. `transaction` then reaches
/// the other thread, having written into the first; the root must be free
/// while it waits there. Then the other teammate goes. Both replies must be
/// kept and every side must finish.
pub(crate) async fn beside_thread_writers<T: Send + 'static>(
    pool: &PgPool,
    project_id: Uuid,
    root: Uuid,
    threads: [Uuid; 2],
    transaction: impl Future<Output = anyhow::Result<T>> + Send + 'static,
) -> anyhow::Result<T> {
    let hold = format!("hold_thread_writer_{}", Uuid::new_v4().simple());
    let held_threads = threads
        .iter()
        .map(Uuid::to_string)
        .collect::<Vec<_>>()
        .join(",");
    pool.get()
        .await?
        .batch_execute(&format!(
            "create function {hold}() returns trigger language plpgsql as $fn$
             begin
                 perform pg_advisory_xact_lock_shared(
                     hashtextextended('{hold}:' || pg_backend_pid(), 0));
                 return null;
             end
             $fn$;
             create trigger {hold} after update on conversations
                 for each row when (new.id = any('{{{held_threads}}}'::uuid[]))
                 execute function {hold}();"
        ))
        .await?;
    let outcome = std::panic::AssertUnwindSafe(run_beside_thread_writers(
        pool,
        &hold,
        project_id,
        root,
        threads,
        transaction,
    ))
    .catch_unwind()
    .await;
    // Removed however the run ended, a panic included, once every connection
    // it opened is closed. A writer still held then goes on as soon as the
    // test's own connection, holding its advisory lock, has closed.
    let removed = async {
        let (cleanup, cleanup_driver, _) = own_connection().await?;
        cleanup
            .batch_execute(&format!(
                "set lock_timeout = '30s';
                 drop trigger {hold} on conversations;
                 drop function {hold}();"
            ))
            .await?;
        drop(cleanup);
        let _ = cleanup_driver.await;
        anyhow::Ok(())
    }
    .await;
    match outcome {
        Ok(result) => {
            let value = result?;
            removed?;
            Ok(value)
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn run_beside_thread_writers<T: Send + 'static>(
    pool: &PgPool,
    hold: &str,
    project_id: Uuid,
    root: Uuid,
    threads: [Uuid; 2],
    transaction: impl Future<Output = anyhow::Result<T>> + Send + 'static,
) -> anyhow::Result<T> {
    let (control, control_driver, control_pid) = own_connection().await?;
    let key = |pid: i32| format!("{hold}:{pid}");
    let mut writers = Vec::with_capacity(threads.len());
    for thread in threads {
        let (client, driver, pid) = own_connection().await?;
        control
            .execute(
                "select pg_advisory_lock(hashtextextended($1, 0))",
                &[&key(pid)],
            )
            .await?;
        // Aborted if this returns early, so it never outlives the test.
        let writing = spawn_aborting(async move {
            let mut client = client;
            let write = client.transaction().await?;
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
            .map_err(|error| controller_error("the teammate's reply", error))?;
            write.commit().await?;
            anyhow::Ok(())
        });
        writers.push(ThreadWriter {
            thread,
            pid,
            writing,
            driver,
        });
    }
    let observer = pool.get().await?;
    for writer in &writers {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let held: bool = observer
                .query_one(
                    "select $2 = any(pg_blocking_pids($1))",
                    &[&writer.pid, &control_pid],
                )
                .await?
                .get(0);
            if held {
                break;
            }
            anyhow::ensure!(
                !writer.writing.is_finished() && Instant::now() < deadline,
                "the teammate in {} was never held between its thread and the root",
                writer.thread
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    anyhow::ensure!(
        !would_wait(pool, "conversations", "id", root, "share").await?,
        "the teammates hold their threads, not the root"
    );

    // Aborted if this returns early, so it never outlives the test.
    let testing = spawn_aborting(transaction);
    // Until it waits for one of the teammates.
    let writer_pids: Vec<i32> = writers.iter().map(|writer| writer.pid).collect();
    let deadline = Instant::now() + Duration::from_secs(10);
    let first = loop {
        let waited_for: Option<i32> = observer
            .query_opt(
                "select writer from unnest($1::int[]) as writer
                  where exists (select 1 from pg_stat_activity
                                 where writer = any(pg_blocking_pids(pid)))
                  limit 1",
                &[&writer_pids],
            )
            .await?
            .map(|row| row.get(0));
        if let Some(pid) = waited_for {
            break pid;
        }
        if testing.is_finished() {
            let outcome = testing.await?;
            anyhow::bail!(
                "the transaction finished without waiting for either thread: {:?}",
                outcome.map(|_| ())
            );
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "the transaction never waited for either thread"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let first = writers
        .iter()
        .position(|writer| writer.pid == first)
        .ok_or_else(|| anyhow::anyhow!("no teammate has pid {first}"))?;
    let second = writers.remove(1 - first);
    let first = writers.remove(0);

    // The first teammate goes, bumps the root and commits.
    control
        .execute(
            "select pg_advisory_unlock(hashtextextended($1, 0))",
            &[&key(first.pid)],
        )
        .await?;
    tokio::time::timeout(FINISH_WITHIN, first.writing)
        .await??
        .map_err(|error| error.context(format!("the teammate in {}", first.thread)))?;
    let _ = first.driver.await;

    // The transaction goes on into the other thread, having written into the
    // first, and waits for its teammate.
    anyhow::ensure!(
        seen_waited_for(pool, &testing, second.pid).await?,
        "the transaction never reached the second thread"
    );
    let root_held = would_wait(pool, "conversations", "id", root, "share").await?;
    control
        .execute(
            "select pg_advisory_unlock(hashtextextended($1, 0))",
            &[&key(second.pid)],
        )
        .await?;
    let written = tokio::time::timeout(FINISH_WITHIN, second.writing).await?;
    let outcome = tokio::time::timeout(FINISH_WITHIN, testing).await?;
    drop(observer);
    drop(control);
    let _ = control_driver.await;
    let _ = second.driver.await;

    assert!(
        !root_held,
        "the transaction waits for the second thread while it holds the root"
    );
    written?.map_err(|error| error.context(format!("the teammate in {}", second.thread)))?;
    let outcome = outcome??;
    let kept: i64 = pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages
              where conversation_id = any($1) and content = $2",
            &[&threads.to_vec(), &THREAD_REPLY],
        )
        .await?
        .get(0);
    assert_eq!(kept, 2, "both teammates' replies are kept");
    Ok(outcome)
}

/// A managed-AI dispatch running on its own task.
pub(crate) type Dispatching = AbortingTask<anyhow::Result<crate::dispatch::DispatchPromptResponse>>;

/// How many managed-AI reserves the ledger of `project_id` has for prompts
/// other than `prompt_id`. A [`DispatchFence::held_dispatch`] that went on
/// past its fence wrote one.
pub(crate) async fn reserves_besides(
    pool: &PgPool,
    project_id: Uuid,
    prompt_id: Uuid,
) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from org_credit_ledger
              where project_id = $1
                and idempotency_key like 'managed-ai-prompt:%'
                and idempotency_key <> 'managed-ai-prompt:' || $2",
            &[&project_id, &prompt_id.to_string()],
        )
        .await?
        .get(0))
}

/// The test's hold on a conversation's dispatch fence, the advisory lock
/// every dispatch into the conversation takes right after it locked the
/// conversation `for update` (`dispatch.rs`, `ensure_conversation_record`).
/// A dispatch into the conversation meanwhile waits there, holding the
/// conversation and before it reserves anything.
pub(crate) struct DispatchFence {
    conversation_id: Uuid,
    control: tokio_postgres::Client,
    driver: Driver,
    pid: i32,
    key: String,
}

impl DispatchFence {
    pub(crate) async fn hold(conversation_id: Uuid) -> anyhow::Result<Self> {
        let (control, driver, pid) = own_connection().await?;
        let key = format!("conversation-dispatch:{conversation_id}");
        control
            .execute("select pg_advisory_lock(hashtextextended($1, 0))", &[&key])
            .await?;
        Ok(Self {
            conversation_id,
            control,
            driver,
            pid,
            key,
        })
    }

    /// Starts `owner`'s managed-AI dispatch of `prompt` into the conversation,
    /// a conversation of `project_id`, and returns it with its backend's pid
    /// once it waits at the fence. Past the fence it reserves the org's
    /// credit, in the same transaction.
    ///
    /// The prompt addresses Octo, so a group conversation's turn is a direct
    /// one rather than an ambient evaluation, which defers its billing. The
    /// test config has no proxy, so the dispatch runs on a state whose
    /// managed lane has an inert key, as `self_hosted_platform_lane_tests`
    /// does: without it the managed-AI gate refuses the turn.
    pub(crate) async fn held_dispatch(
        &self,
        state: &crate::AppState,
        project_id: Uuid,
        owner: Uuid,
        prompt: &str,
    ) -> anyhow::Result<(Dispatching, i32)> {
        let mut config = state.config.clone();
        config.managed_ai_openai_api_key = Some("sk-managed-test".to_string());
        let managed_state = crate::tests::build_test_state(state.pool.clone(), config);
        let request =
            crate::dispatch::normalize_dispatch_request(crate::dispatch::DispatchPromptRequest {
                project_id: Some(project_id.to_string()),
                session_id: None,
                prompt_text: Some(format!("@octo {prompt}")),
                intent: Some("feature".to_string()),
                plan_seed: None,
                metadata: Some(json!({
                    "clientMessageId": Uuid::new_v4().to_string(),
                    "agentSelection": { "active": ["octo"], "mentions": [] }
                })),
                conversation_metadata: None,
                parent_conversation_id: None,
                thread_kind: None,
                tool_limits: None,
                repo: None,
                ui: None,
                priority: None,
                runtime_type: None,
                idle_ttl_seconds: None,
                conversation_id: Some(self.conversation_id.to_string()),
                runtime_id: None,
                runtime_display_name: None,
                prefer_runtime: None,
            })
            .map_err(|error| controller_error("normalizing the dispatch", error))?;
        let observer = state.pool.get().await?;
        // Aborted if the test returns early, so it never outlives the test.
        let dispatching = spawn_aborting(async move {
            crate::dispatch::process_dispatch_prompt(
                &managed_state,
                &crate::auth::RequestContext {
                    user_id: Some(owner),
                    is_service_role: false,
                    scoped_claims: None,
                },
                request,
            )
            .await
            .map_err(|error| controller_error("the managed-AI dispatch", error))
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(row) = observer
                .query_opt(
                    "select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
                    &[&self.pid],
                )
                .await?
            {
                return Ok((dispatching, row.get(0)));
            }
            if dispatching.is_finished() {
                let outcome = dispatching.await?;
                anyhow::bail!(
                    "the dispatch finished without reaching its fence: {:?}",
                    outcome.map(|response| response.status)
                );
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "the dispatch never reached its fence"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Lets the dispatch go on.
    pub(crate) async fn release(self) -> anyhow::Result<()> {
        self.control
            .execute(
                "select pg_advisory_unlock(hashtextextended($1, 0))",
                &[&self.key],
            )
            .await?;
        drop(self.control);
        let _ = self.driver.await;
        Ok(())
    }
}

/// What [`HeldRunMessage`] writes.
pub(crate) const RUN_MESSAGE: &str = "Starting a machine for this.";

/// A message naming a run, written on a connection of its own and held
/// between its insert and its conversation's update. The runtime alert a
/// dispatch writes once it has committed is one, and it locks no job first:
/// the insert takes a key-share lock on the run, the prompt and the
/// conversation, and the update then needs the conversation's row.
pub(crate) struct HeldRunMessage {
    client: tokio_postgres::Client,
    driver: Driver,
    pub(crate) pid: i32,
    conversation_id: Uuid,
}

impl HeldRunMessage {
    pub(crate) async fn insert(
        project_id: Uuid,
        conversation_id: Uuid,
        run_id: Uuid,
        prompt_id: Option<Uuid>,
    ) -> anyhow::Result<Self> {
        let (client, driver, pid) = own_connection().await?;
        client.batch_execute("begin").await?;
        client
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, prompt_id, run_id, role, content, metadata
                 ) values ($1, $2, $3, $4, $5, 'assistant', $6, '{}'::jsonb)",
                &[
                    &Uuid::new_v4(),
                    &conversation_id,
                    &project_id,
                    &prompt_id,
                    &run_id,
                    &RUN_MESSAGE,
                ],
            )
            .await?;
        Ok(Self {
            client,
            driver,
            pid,
            conversation_id,
        })
    }

    /// Updates the conversation, as the writer does next, and commits.
    pub(crate) async fn finish(self) -> anyhow::Result<()> {
        self.client
            .execute(
                "update conversations set updated_at = now() where id = $1",
                &[&self.conversation_id],
            )
            .await?;
        self.client.batch_execute("commit").await?;
        drop(self.client);
        let _ = self.driver.await;
        Ok(())
    }
}

/// How many [`HeldRunMessage`]s `conversation_id` keeps.
pub(crate) async fn run_messages(pool: &PgPool, conversation_id: Uuid) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages
              where conversation_id = $1 and content = $2",
            &[&conversation_id, &RUN_MESSAGE],
        )
        .await?
        .get(0))
}
