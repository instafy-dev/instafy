//! An agent completion commits and publishes the turn's reply and the run's
//! end before it bills the turn. Billing (managed-AI usage reconciliation),
//! Home's feed rows and the runtime's `agent.complete` event follow in their
//! own transactions, so the reply never waits on the org's credit balance,
//! and a billing failure cannot take the reply down with it.

use crate::agent;
use crate::state::ControllerEvent;
use crate::tests_managed_ai_refund::{
    agent_complete_request, credit_balance, ledger_rows, run_row, seed_reserved_managed_ai_prompt,
    ReservedManagedAiPrompt,
};
use axum::http::StatusCode;
use serde_json::json;
use std::time::Duration;
use tokio::sync::broadcast;
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
    {
        let connection = fixture.pool.get().await?;
        let home_rows: Vec<String> = connection
            .query(
                "select kind from activity_events where run_id = $1 order by id",
                &[&fixture.run_id],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        assert!(
            home_rows.ends_with(&[
                crate::activity::KIND_RUN_FINISHED.to_string(),
                crate::activity::KIND_CONVERSATION_REPLY.to_string(),
            ]),
            "Home records the run's end, then the reply, got {home_rows:?}"
        );
    }
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
