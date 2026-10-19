//! An agent completion commits and publishes the turn's reply and the run's
//! end before it bills the turn. Billing (managed-AI usage reconciliation),
//! Home's feed rows and the runtime's `agent.complete` event follow in their
//! own transactions, so the reply never waits on the org's credit balance,
//! and a billing failure cannot take the reply down with it. The
//! conversation's next queued send does not wait for the billing either.

use crate::agent;
use crate::state::ControllerEvent;
use crate::tests_managed_ai_refund::{
    agent_complete_request, credit_balance, ledger_metadata_by_key, ledger_rows, run_row,
    seed_reserved_managed_ai_prompt, ReservedManagedAiPrompt,
};
use axum::http::StatusCode;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::NoTls;
use tower::ServiceExt;
use uuid::Uuid;

const REPLY: &str = "The path is /workspace.";

/// A succeeded completion whose 3,000 output tokens cost two credits against
/// the one-credit reserve, so billing writes an adjustment under the org's
/// balance row lock.
fn completion_body(fixture: &ReservedManagedAiPrompt) -> serde_json::Value {
    json!({
        "job_id": fixture.job_id,
        "outcome": "succeeded",
        "summary": REPLY,
        "artifacts": [{
            "kind": "codex/run-log",
            "events": [{
                "type": "turn.completed",
                "usage": { "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 3000 }
            }]
        }],
    })
}

/// Waits until the reply's `conversation.message_created` and the run's
/// `run.completed` have both been published.
async fn wait_for_reply_and_run_end(
    events: &mut broadcast::Receiver<ControllerEvent>,
    fixture: &ReservedManagedAiPrompt,
    within: Duration,
) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + within;
    let (mut reply, mut run_end) = (false, false);
    while !(reply && run_end) {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .map_err(|_| {
                anyhow::anyhow!("not published in time: reply={reply} run.completed={run_end}")
            })??;
        if event.project_id != Some(fixture.project_id) {
            continue;
        }
        match event.kind.as_str() {
            "conversation.message_created"
                if event.data.get("content").and_then(|value| value.as_str()) == Some(REPLY) =>
            {
                reply = true;
            }
            "run.completed" if event.run_id == Some(fixture.run_id) => run_end = true,
            _ => {}
        }
    }
    Ok(())
}

async fn reply_count(fixture: &ReservedManagedAiPrompt) -> anyhow::Result<i64> {
    let connection = fixture.pool.get().await?;
    Ok(connection
        .query_one(
            "select count(*) from conversation_messages
             where run_id = $1 and role = 'assistant' and content = $2",
            &[&fixture.run_id, &REPLY],
        )
        .await?
        .get(0))
}

/// Home's rows for the fixture's run, oldest first.
async fn home_row_kinds(fixture: &ReservedManagedAiPrompt) -> anyhow::Result<Vec<String>> {
    let connection = fixture.pool.get().await?;
    Ok(connection
        .query(
            "select kind from activity_events where run_id = $1 order by id",
            &[&fixture.run_id],
        )
        .await?
        .iter()
        .map(|row| row.get(0))
        .collect())
}

fn adjustment_rows(rows: &[(String, i32, Option<String>)], prompt_id: Uuid) -> usize {
    let key = format!("managed-ai-adjustment:{prompt_id}");
    rows.iter()
        .filter(|(_, _, idempotency_key)| idempotency_key.as_deref() == Some(key.as_str()))
        .count()
}

#[tokio::test]
async fn a_completion_shows_its_reply_while_billing_waits_on_the_org_balance() -> anyhow::Result<()>
{
    let Some(fixture) = seed_reserved_managed_ai_prompt("reply-before-billing").await? else {
        eprintln!("skipping reply-before-billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let _watch = fixture.state.events.watch_project(fixture.project_id);
    let mut events = fixture.state.events.subscribe();
    let request = agent_complete_request(&fixture, completion_body(&fixture)).await?;

    // Hold the org's balance row, as a concurrent dispatch or the hosted
    // credit sweep in the same org would.
    let (holder, holder_connection) =
        tokio_postgres::connect(&std::env::var("TEST_DATABASE_URL")?, NoTls).await?;
    let holder_driver = tokio::spawn(holder_connection);
    holder.batch_execute("begin").await?;
    holder
        .execute(
            "select 1 from org_credit_balances where org_id = $1 for update",
            &[&fixture.org_id],
        )
        .await?;

    let router = agent::router().with_state(fixture.state.clone());
    let pending = tokio::spawn(async move { router.oneshot(request).await });

    let shown = wait_for_reply_and_run_end(&mut events, &fixture, Duration::from_secs(10)).await;
    // Read while the balance is still held, then let billing go before any
    // assertion can fail, so a failure never strands the completion.
    let replies_while_held = reply_count(&fixture).await?;
    let (run_status_while_held, _) = run_row(&fixture.pool, &fixture.run_id).await?;
    let adjustments_while_held = adjustment_rows(
        &ledger_rows(&fixture.pool, &fixture.project_id).await?,
        fixture.prompt_id,
    );
    holder.batch_execute("rollback").await?;
    drop(holder);
    let _ = holder_driver.await;

    shown?;
    assert_eq!(replies_while_held, 1, "the reply committed before billing");
    assert_eq!(run_status_while_held, "success");
    assert_eq!(
        adjustments_while_held, 0,
        "billing waited on the balance row"
    );

    let response = tokio::time::timeout(Duration::from_secs(20), pending).await???;
    assert_eq!(response.status(), StatusCode::OK);
    let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
    assert_eq!(
        adjustment_rows(&rows, fixture.prompt_id),
        1,
        "the turn is billed once its balance row is free, got {rows:?}"
    );
    assert_eq!(
        credit_balance(&fixture.pool, &fixture.org_id).await?,
        fixture.reserved_balance - 1
    );
    let (_, run_metadata) = run_row(&fixture.pool, &fixture.run_id).await?;
    assert_eq!(
        run_metadata["managedAiCredit"]["charge"]["adjustmentUnits"],
        json!(1),
        "the run still carries its credit trace"
    );
    let home_rows = home_row_kinds(&fixture).await?;
    assert!(
        home_rows.ends_with(&[
            crate::activity::KIND_RUN_FINISHED.to_string(),
            crate::activity::KIND_CONVERSATION_REPLY.to_string(),
        ]),
        "Home records the run's end, then the reply, got {home_rows:?}"
    );
    fixture.cleanup().await
}

#[tokio::test]
async fn a_completion_whose_billing_fails_still_lands_its_reply() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("reply-despite-billing").await? else {
        eprintln!("skipping reply-despite-billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    // Usage reconciliation cannot find the org to bill.
    {
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update projects set org_id = null where id = $1",
                &[&fixture.project_id],
            )
            .await?;
    }
    let request = agent_complete_request(&fixture, completion_body(&fixture)).await?;
    let response = agent::router()
        .with_state(fixture.state.clone())
        .oneshot(request)
        .await?;
    {
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update projects set org_id = $2 where id = $1",
                &[&fixture.project_id, &fixture.org_id],
            )
            .await?;
    }

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(reply_count(&fixture).await?, 1);
    let (run_status, _) = run_row(&fixture.pool, &fixture.run_id).await?;
    assert_eq!(run_status, "success");
    {
        let connection = fixture.pool.get().await?;
        let job_status: String = connection
            .query_one(
                "select status from agent_jobs where id = $1",
                &[&fixture.job_id],
            )
            .await?
            .get(0);
        assert_eq!(job_status, "completed");
    }
    assert_eq!(
        adjustment_rows(
            &ledger_rows(&fixture.pool, &fixture.project_id).await?,
            fixture.prompt_id
        ),
        0
    );
    fixture.cleanup().await
}

/// Log lines written while the test's subscriber is the default. The
/// completion's settlement runs on the test's own thread.
#[derive(Clone, Default)]
struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

impl CapturedLogs {
    fn contents(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("log buffer poisoned")).into_owned()
    }
}

impl std::io::Write for CapturedLogs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("log buffer poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Makes the first `update` of `table` that matches `when` fail, once: a
/// sequence, which a rollback does not undo, counts the matching updates.
struct FailOnce {
    name: String,
    table: &'static str,
}

impl FailOnce {
    async fn install(
        fixture: &ReservedManagedAiPrompt,
        table: &'static str,
        when: &str,
    ) -> anyhow::Result<Self> {
        let name = format!("fail_once_{}", Uuid::new_v4().simple());
        fixture
            .pool
            .get()
            .await?
            .batch_execute(&format!(
                "create sequence {name};
                 create function {name}() returns trigger language plpgsql as $fn$
                 begin
                     if nextval('{name}') = 1 then
                         raise exception 'injected failure in {table}';
                     end if;
                     return new;
                 end
                 $fn$;
                 create trigger {name} before update on {table}
                     for each row when ({when}) execute function {name}();"
            ))
            .await?;
        Ok(Self { name, table })
    }

    /// How many matching updates ran, the failed one among them.
    async fn updates(&self, fixture: &ReservedManagedAiPrompt) -> anyhow::Result<i64> {
        Ok(fixture
            .pool
            .get()
            .await?
            .query_one(&format!("select last_value from {}", self.name), &[])
            .await?
            .get(0))
    }

    async fn remove(self, fixture: &ReservedManagedAiPrompt) -> anyhow::Result<()> {
        let Self { name, table } = self;
        fixture
            .pool
            .get()
            .await?
            .batch_execute(&format!(
                "drop trigger {name} on {table};
                 drop function {name}();
                 drop sequence {name};"
            ))
            .await?;
        Ok(())
    }
}

/// A statement that fails in the billing transaction leaves it aborted, and
/// COMMIT then rolls it back without an error. Whether the failure surfaced
/// (the reserve row's usage merge) or was only logged (the run's credit
/// trace), the attempt is an error, logged as one, and the retry bills the
/// turn exactly once.
#[tokio::test]
async fn a_billing_attempt_a_failed_statement_aborted_is_retried_not_lost() -> anyhow::Result<()> {
    for (label, table) in [
        ("billing-merge-fails-once", "org_credit_ledger"),
        ("billing-trace-fails-once", "runs"),
    ] {
        let Some(fixture) = seed_reserved_managed_ai_prompt(label).await? else {
            eprintln!("skipping billing retry test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let when = match table {
            "org_credit_ledger" => format!(
                "new.idempotency_key = 'managed-ai-prompt:{}' and new.metadata ? 'billingKind'",
                fixture.prompt_id
            ),
            _ => format!(
                "new.id = '{}'::uuid and new.metadata #> '{{managedAiCredit,charge}}' is not null",
                fixture.run_id
            ),
        };
        let fail_once = FailOnce::install(&fixture, table, &when).await?;

        let logs = CapturedLogs::default();
        let subscriber = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_writer({
                    let logs = logs.clone();
                    move || logs.clone()
                })
                .with_ansi(false)
                .finish(),
        );
        let request = agent_complete_request(&fixture, completion_body(&fixture)).await?;
        let response = agent::router()
            .with_state(fixture.state.clone())
            .oneshot(request)
            .await;
        drop(subscriber);
        let updates = fail_once.updates(&fixture).await;
        fail_once.remove(&fixture).await?;

        assert_eq!(response?.status(), StatusCode::OK, "{label}");
        assert_eq!(updates?, 2, "{label}: the failed attempt, then the retry");
        let logs = logs.contents();
        assert!(
            logs.contains("ERROR")
                && logs.contains(
                    "failed to reconcile managed AI usage after agent completion; retrying"
                ),
            "{label}: the failed attempt is logged as an error, got {logs}"
        );
        assert!(
            !logs.contains("the reserve stands as the charge"),
            "{label}: the retry billed the turn, got {logs}"
        );
        let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
        assert_eq!(
            adjustment_rows(&rows, fixture.prompt_id),
            1,
            "{label}: billed once, got {rows:?}"
        );
        assert_eq!(
            credit_balance(&fixture.pool, &fixture.org_id).await?,
            fixture.reserved_balance - 1,
            "{label}"
        );
        let (_, run_metadata) = run_row(&fixture.pool, &fixture.run_id).await?;
        assert_eq!(
            run_metadata["managedAiCredit"]["charge"]["adjustmentUnits"],
            json!(1),
            "{label}: the run carries its credit trace"
        );
        fixture.cleanup().await?;
    }
    Ok(())
}

/// The conversation's next queued send dispatches as soon as the turn's reply
/// is committed: its dispatch reserves its own credits, so it does not wait
/// for the turn's billing, here held up on the reserve row. Home's rows for
/// the turn do not wait for the billing either.
#[tokio::test]
async fn the_next_queued_send_goes_out_behind_the_reply_before_the_billing() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("queued-send-before-billing").await? else {
        eprintln!("skipping queued-send-before-billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let conversation_id: Uuid = fixture
        .pool
        .get()
        .await?
        .query_one(
            "select conversation_id from agent_jobs where id = $1",
            &[&fixture.job_id],
        )
        .await?
        .get(0);
    // Queued while the turn ran.
    let entry_id = Uuid::new_v4();
    fixture
        .pool
        .get()
        .await?
        .execute(
            "insert into conversation_send_queue (
                 id, project_id, conversation_id, user_id, request
             ) values ($1, $2, $3, $4, $5)",
            &[
                &entry_id,
                &fixture.project_id,
                &conversation_id,
                &fixture.owner_user_id,
                &PgJson(json!({
                    "promptText": "And the green one?",
                    "intent": "feature",
                    "metadata": { "agentSelection": { "active": ["octo"], "mentions": [] } },
                })),
            ],
        )
        .await?;
    let _watch = fixture.state.events.watch_project(fixture.project_id);
    let mut events = fixture.state.events.subscribe();
    // 1,500 tokens cost exactly the reserve: billing writes no ledger row and
    // takes no balance lock, it only merges the usage into the reserve row.
    let mut body = completion_body(&fixture);
    body["artifacts"][0]["events"][0]["usage"] =
        json!({ "input_tokens": 1200, "cached_input_tokens": 0, "output_tokens": 300 });
    let request = agent_complete_request(&fixture, body).await?;

    let (holder, holder_connection) =
        tokio_postgres::connect(&std::env::var("TEST_DATABASE_URL")?, NoTls).await?;
    let holder_driver = tokio::spawn(holder_connection);
    holder.batch_execute("begin").await?;
    holder
        .execute(
            "select 1 from org_credit_ledger where idempotency_key = $1 for update",
            &[&format!("managed-ai-prompt:{}", fixture.prompt_id)],
        )
        .await?;

    let router = agent::router().with_state(fixture.state.clone());
    let pending = tokio::spawn(async move { router.oneshot(request).await });

    // The reply, then the queued send's dispatch outcome, while the billing
    // still waits on the reserve row.
    let order = async {
        let mut seen = Vec::new();
        loop {
            let event = events.recv().await?;
            if event.project_id != Some(fixture.project_id) {
                continue;
            }
            match event.kind.as_str() {
                "conversation.message_created"
                    if event.data.get("content").and_then(|value| value.as_str())
                        == Some(REPLY) =>
                {
                    seen.push("reply");
                }
                "conversation.sendQueue"
                    if event.data["entry"]["id"] == json!(entry_id)
                        && event.data["action"] != json!("enqueued") =>
                {
                    seen.push("queued send");
                    return anyhow::Ok(seen);
                }
                _ => {}
            }
        }
    };
    let order = tokio::time::timeout(Duration::from_secs(10), order).await;
    let reconciled_while_held = ledger_metadata_by_key(
        &fixture.pool,
        &fixture.project_id,
        &format!("managed-ai-prompt:{}", fixture.prompt_id),
    )
    .await?["billingKind"]
        .clone();
    let entry_status: String = fixture
        .pool
        .get()
        .await?
        .query_one(
            "select status from conversation_send_queue where id = $1",
            &[&entry_id],
        )
        .await?
        .get(0);
    let turn_rows = [
        crate::activity::KIND_RUN_FINISHED.to_string(),
        crate::activity::KIND_CONVERSATION_REPLY.to_string(),
    ];
    let home_rows_while_held = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if home_row_kinds(&fixture).await?.ends_with(&turn_rows) {
                break anyhow::Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    holder.batch_execute("rollback").await?;
    drop(holder);
    let _ = holder_driver.await;

    let order =
        order.map_err(|_| anyhow::anyhow!("the queued send waited for the turn's billing"))??;
    assert_eq!(order, vec!["reply", "queued send"]);
    assert_ne!(entry_status, "queued");
    home_rows_while_held
        .map_err(|_| anyhow::anyhow!("Home's rows for the turn waited for its billing"))??;
    assert_eq!(
        reconciled_while_held,
        serde_json::Value::Null,
        "the billing was still waiting"
    );

    let response = tokio::time::timeout(Duration::from_secs(20), pending).await???;
    assert_eq!(response.status(), StatusCode::OK);
    let reserve = ledger_metadata_by_key(
        &fixture.pool,
        &fixture.project_id,
        &format!("managed-ai-prompt:{}", fixture.prompt_id),
    )
    .await?;
    assert_eq!(
        reserve["billingKind"],
        json!("token_usage_reconciled"),
        "the turn is billed once the reserve row is free"
    );
    fixture.cleanup().await
}
