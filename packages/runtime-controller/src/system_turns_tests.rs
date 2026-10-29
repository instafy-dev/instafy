//! Database tests for turns Instafy starts by itself (crate::system_turns):
//! such a turn costs what any turn costs only when it ends with Octo's reply,
//! and dispatch marks a resend as one only after checking its failure. They
//! run against the migrated test database (`pnpm test:controller`).

use super::*;
use crate::system_turns::{
    AUTOMATIC_RETRY_KEY, BROWSER_CARD_TURN_KEY, BROWSER_CARD_WITHOUT_PAGE_REFUND_REASON,
    FAILED_TURN_WITHOUT_RESULT_REFUND_REASON, SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON,
};
use crate::tests_managed_ai_refund::{
    agent_complete_request, credit_balance, daily_prompts_used, ledger_rows, post_agent_message,
    run_row, seed_reserved_managed_ai_prompt, ReservedManagedAiPrompt,
};

/// 3,000 output tokens cost two credits against the one-credit reserve.
fn run_log_with_usage() -> serde_json::Value {
    json!({
        "kind": "codex/run-log",
        "events": [
            {
                "type": "turn.completed",
                "usageScope": "turn",
                "usage": { "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 3000 }
            }
        ]
    })
}

/// Puts the controller's own stamp for a turn Instafy started on the
/// fixture's job, as dispatch does for one it checked.
async fn stamp(
    fixture: &ReservedManagedAiPrompt,
    key: &str,
    record: serde_json::Value,
) -> anyhow::Result<()> {
    fixture
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs
                set payload = jsonb_set(payload, array['metadata', $2::text], $3::jsonb, true)
              where id = $1",
            &[&fixture.job_id, &key, &PgJson(record)],
        )
        .await?;
    Ok(())
}

async fn complete(
    fixture: &ReservedManagedAiPrompt,
    body: serde_json::Value,
) -> anyhow::Result<StatusCode> {
    let request = agent_complete_request(fixture, body).await?;
    let response = crate::agent::router()
        .with_state(fixture.state.clone())
        .oneshot(request)
        .await?;
    Ok(response.status())
}

fn reasons(rows: &[(String, i32, Option<String>)]) -> Vec<(&str, i32)> {
    rows.iter()
        .map(|(reason, delta, _)| (reason.as_str(), *delta))
        .collect()
}

/// The reserve came back once, the daily prompt slot with it, no token was
/// billed, and the run says it was a turn Instafy started without a reply.
async fn assert_given_back(fixture: &ReservedManagedAiPrompt) -> anyhow::Result<()> {
    assert_given_back_for(fixture, SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON).await
}

/// The reserve came back once, the daily prompt slot with it, no token was
/// billed, and the run says why: `reason`.
async fn assert_given_back_for(
    fixture: &ReservedManagedAiPrompt,
    reason: &str,
) -> anyhow::Result<()> {
    let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
    let reasons = reasons(&rows);
    assert_eq!(
        reasons
            .iter()
            .filter(|(reason, _)| *reason == "managed_ai_refund")
            .collect::<Vec<_>>(),
        vec![&("managed_ai_refund", fixture.burn_amount)],
        "{rows:?}"
    );
    assert!(
        !reasons
            .iter()
            .any(|(reason, _)| *reason == "managed_ai_adjustment"),
        "no token is billed: {rows:?}"
    );
    assert_eq!(
        credit_balance(&fixture.pool, &fixture.org_id).await?,
        fixture.reserved_balance + fixture.burn_amount
    );
    assert_eq!(
        daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
        0
    );
    let (_, run_metadata) = run_row(&fixture.pool, &fixture.run_id).await?;
    assert_eq!(
        run_metadata["managedAiCredit"]["refund"]["refundReason"],
        json!(reason)
    );
    Ok(())
}

/// One step of the fixture's turn as the runtime streams it: its start, then
/// its end with `status`. `details` names the tool or command.
async fn step(
    fixture: &ReservedManagedAiPrompt,
    message_type: &str,
    details: serde_json::Value,
    status: &str,
) -> anyhow::Result<()> {
    let item_id = format!("item-{}", Uuid::new_v4());
    for (event, state) in [("item.started", "in_progress"), ("item.completed", status)] {
        let mut metadata = details.clone();
        metadata["itemId"] = json!(item_id);
        metadata["status"] = json!(state);
        metadata["eventType"] = json!(event);
        if message_type == "command_execution" && event == "item.completed" {
            metadata["exitCode"] = json!(if status == "completed" { 0 } else { 1 });
        }
        let posted = post_agent_message(
            fixture,
            json!({
                "job_id": fixture.job_id,
                "content": format!("{message_type} {state}"),
                "message_type": message_type,
                "metadata": metadata,
            }),
        )
        .await?;
        assert_eq!(posted, StatusCode::OK, "{message_type} {state}");
    }
    Ok(())
}

/// A call to the browser's own tool `tool`, as Codex reports it.
fn browser_tool(tool: &str) -> serde_json::Value {
    json!({
        "kind": "codex_mcp_tool_call",
        "server": "instafy_shared_browser",
        "tool": tool,
    })
}

/// A command Codex ran.
fn command(command: &str) -> serde_json::Value {
    json!({ "kind": "codex_command_execution", "command": command })
}

/// A note Octo wrote while it worked, which Details shows.
async fn note(fixture: &ReservedManagedAiPrompt, text: &str) -> anyhow::Result<()> {
    let posted = post_agent_message(
        fixture,
        json!({
            "job_id": fixture.job_id,
            "content": text,
            "message_type": "status",
            "metadata": { "kind": "agent_message" },
        }),
    )
    .await?;
    assert_eq!(posted, StatusCode::OK);
    Ok(())
}

/// The runtime's failure for a browser turn that opened no page.
const NO_PAGE_FAILURE: &str = "Octo couldn't open a page in the browser, so this turn stopped.";

/// A turn that ends in the failure block costs nothing when it left the
/// person nothing: here a browser turn that looked at its tabs and whose
/// every page failed to open (a local drive charged such a turn 7 credits).
/// Its model ran and reported tokens, and none is billed.
#[tokio::test]
async fn a_failed_turn_that_left_nothing_costs_nothing() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("failed-turn-left-nothing").await? else {
        eprintln!("skipping failed turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    step(
        &fixture,
        "mcp_tool_call",
        browser_tool("list_tabs"),
        "completed",
    )
    .await?;
    step(
        &fixture,
        "mcp_tool_call",
        browser_tool("navigate"),
        "failed",
    )
    .await?;
    step(
        &fixture,
        "mcp_tool_call",
        browser_tool("snapshot"),
        "failed",
    )
    .await?;
    step(
        &fixture,
        "command_execution",
        command("cat missing.txt"),
        "failed",
    )
    .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "failed",
            "error_message": NO_PAGE_FAILURE,
            "artifacts": [
                run_log_with_usage(),
                { "kind": "apply/files", "files": [] },
            ],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_given_back_for(&fixture, FAILED_TURN_WITHOUT_RESULT_REFUND_REASON).await?;
    fixture.cleanup().await
}

/// A failure alone is not proof that the person got nothing: the runtime
/// fails a turn whose model ended without a final answer, and a model can be
/// asked to. A failed turn that ran a command that worked (its output is in
/// Details), wrote a note, wrote files or opened a page is charged as any
/// turn, so failing on purpose after the work gets nothing for free.
#[tokio::test]
async fn a_failed_turn_that_left_something_costs_its_tokens() -> anyhow::Result<()> {
    for left in ["command", "note", "files", "page"] {
        let Some(fixture) =
            seed_reserved_managed_ai_prompt(&format!("failed-turn-left-{left}")).await?
        else {
            eprintln!("skipping failed turn billing test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let mut artifacts = vec![run_log_with_usage()];
        match left {
            "command" => {
                step(
                    &fixture,
                    "command_execution",
                    command("echo the answer"),
                    "completed",
                )
                .await?
            }
            "note" => {
                note(
                    &fixture,
                    "The answer is 42; I will not write a final reply.",
                )
                .await?
            }
            "files" => artifacts.push(json!({
                "kind": "apply/files",
                "files": [{ "path": "sites/hello/index.html", "changeType": "created" }],
            })),
            _ => {
                step(
                    &fixture,
                    "mcp_tool_call",
                    browser_tool("navigate"),
                    "completed",
                )
                .await?
            }
        }
        let status = complete(
            &fixture,
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": "Codex completed without returning a final assistant message.",
                "artifacts": artifacts,
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{left}");
        assert_charged_its_tokens(&fixture).await?;
        fixture.cleanup().await?;
    }
    Ok(())
}

/// The controller's stamp on a card's browser turn it checked.
fn card_stamp() -> serde_json::Value {
    json!({ "version": 1, "cardJobId": Uuid::new_v4() })
}

/// A card's browser turn is Instafy's: it costs nothing unless it did
/// something in the browser beyond looking at the page it was given. A local
/// drive charged 5 credits for one Studio opened by itself, which read the
/// page it was put on and refused. A refusal is a reply too, so a reply is
/// not what is charged.
#[tokio::test]
async fn a_card_browser_turn_that_only_looked_costs_nothing() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("card-turn-looked").await? else {
        eprintln!("skipping card turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(&fixture, BROWSER_CARD_TURN_KEY, card_stamp()).await?;
    step(
        &fixture,
        "mcp_tool_call",
        browser_tool("list_tabs"),
        "completed",
    )
    .await?;
    step(
        &fixture,
        "mcp_tool_call",
        browser_tool("snapshot"),
        "completed",
    )
    .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "succeeded",
            "summary": "I stopped before researching: the browser is on a page about something else.",
            "artifacts": [run_log_with_usage()],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_given_back_for(&fixture, BROWSER_CARD_WITHOUT_PAGE_REFUND_REASON).await?;
    fixture.cleanup().await
}

/// A card's browser turn that opened a page did its task's work, and costs
/// what its tokens cost, as any turn.
#[tokio::test]
async fn a_card_browser_turn_that_opened_a_page_costs_its_tokens() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("card-turn-opened").await? else {
        eprintln!("skipping card turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(&fixture, BROWSER_CARD_TURN_KEY, card_stamp()).await?;
    step(
        &fixture,
        "mcp_tool_call",
        browser_tool("list_tabs"),
        "completed",
    )
    .await?;
    step(
        &fixture,
        "mcp_tool_call",
        browser_tool("navigate"),
        "completed",
    )
    .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "succeeded",
            "summary": "The tower opens at 10:00.",
            "artifacts": [run_log_with_usage()],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_charged_its_tokens(&fixture).await?;
    fixture.cleanup().await
}

/// Stopping a card's browser turn gives its reserve back unless it had
/// opened a page: what it did, not who stopped it, decides.
#[tokio::test]
async fn stopping_a_card_browser_turn_gives_its_reserve_back_unless_it_opened_a_page(
) -> anyhow::Result<()> {
    for opened in [false, true] {
        let Some(fixture) =
            seed_reserved_managed_ai_prompt(&format!("card-turn-stopped-{opened}")).await?
        else {
            eprintln!("skipping card turn billing test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        stamp(&fixture, BROWSER_CARD_TURN_KEY, card_stamp()).await?;
        step(
            &fixture,
            "mcp_tool_call",
            browser_tool("snapshot"),
            "completed",
        )
        .await?;
        if opened {
            step(
                &fixture,
                "mcp_tool_call",
                browser_tool("open_tab"),
                "completed",
            )
            .await?;
        }
        let mut connection = fixture.pool.get().await?;
        let conversation_id: Uuid = connection
            .query_one(
                "update agent_jobs set status = 'leased', lease_attempts = 1
                  where id = $1
              returning conversation_id",
                &[&fixture.job_id],
            )
            .await?
            .get(0);
        let transaction = connection.transaction().await?;
        let cancellation = crate::conversations::cancel_jobs_with_notice(
            &fixture.config,
            &transaction,
            &fixture.project_id,
            &conversation_id,
            None,
            &[(fixture.job_id, Some(fixture.run_id))],
            "Stopped",
            None,
        )
        .await
        .map_err(|error| controller_error("stop", error))?;
        transaction.commit().await?;
        drop(connection);
        if opened {
            assert!(cancellation.refunded_org_ids.is_empty());
            assert!(
                !reasons(&ledger_rows(&fixture.pool, &fixture.project_id).await?)
                    .iter()
                    .any(|(reason, _)| *reason == "managed_ai_refund"),
                "a turn that opened a page keeps its reserve"
            );
            assert_eq!(
                credit_balance(&fixture.pool, &fixture.org_id).await?,
                fixture.reserved_balance
            );
        } else {
            assert_eq!(cancellation.refunded_org_ids, vec![fixture.org_id]);
            assert_given_back_for(&fixture, BROWSER_CARD_WITHOUT_PAGE_REFUND_REASON).await?;
        }
        fixture.cleanup().await?;
    }
    Ok(())
}

/// A turn the person sent whose machine was lost ends in the failure block
/// too. One that a runtime held and that left nothing gives its reserve back;
/// one with a step that worked keeps it, as it did before.
#[tokio::test]
async fn an_expired_turn_that_left_nothing_gives_its_reserve_back() -> anyhow::Result<()> {
    for worked in [false, true] {
        let Some(fixture) =
            seed_reserved_managed_ai_prompt(&format!("expired-turn-worked-{worked}")).await?
        else {
            eprintln!("skipping expired turn billing test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        step(
            &fixture,
            "command_execution",
            command("ls"),
            if worked { "completed" } else { "failed" },
        )
        .await?;
        let mut connection = fixture.pool.get().await?;
        let payload: PgJson<serde_json::Value> = connection
            .query_one(
                "select payload from agent_jobs where id = $1",
                &[&fixture.job_id],
            )
            .await?
            .get(0);
        let mut transaction = connection.transaction().await?;
        let refunded = crate::runtime::refund_managed_ai_reserve_for_expired_job(
            &mut transaction,
            &fixture.project_id,
            &fixture.job_id,
            Some(fixture.run_id),
            1,
            &payload.0,
            "runtime_not_ready",
        )
        .await?;
        transaction.commit().await?;
        drop(connection);
        if worked {
            assert_eq!(refunded, None);
            assert_eq!(
                credit_balance(&fixture.pool, &fixture.org_id).await?,
                fixture.reserved_balance
            );
            assert_eq!(
                daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
                1
            );
        } else {
            assert_eq!(refunded, Some(fixture.org_id));
            assert_given_back_for(&fixture, "runtime_not_ready").await?;
        }
        fixture.cleanup().await?;
    }
    Ok(())
}

/// An automatic retry that fails too costs nothing, although its model ran
/// and reported tokens: before, it kept its reserve and was billed for them.
#[tokio::test]
async fn an_automatic_retry_that_fails_costs_nothing() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-fails").await? else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        AUTOMATIC_RETRY_KEY,
        json!({ "version": 1, "failedRunId": Uuid::new_v4() }),
    )
    .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "failed",
            "error_message": "Octo didn't finish the changes.",
            "artifacts": [run_log_with_usage()],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_given_back(&fixture).await?;
    fixture.cleanup().await
}

/// A hand-back that finishes with nothing to say gives its reserve back.
#[tokio::test]
async fn a_hand_back_that_ends_without_a_reply_costs_nothing() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-silent").await? else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        crate::browser_hand_back::HAND_BACK_KEY,
        json!({ "version": 1, "browserJobId": Uuid::new_v4() }),
    )
    .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "succeeded",
            "summary": "   ",
            "artifacts": [run_log_with_usage()],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_given_back(&fixture).await?;
    fixture.cleanup().await
}

/// A hand-back that ends with Octo's reply costs what its tokens cost, as any
/// turn does.
#[tokio::test]
async fn a_hand_back_that_ends_with_a_reply_costs_its_tokens() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-reply").await? else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        crate::browser_hand_back::HAND_BACK_KEY,
        json!({ "version": 1, "browserJobId": Uuid::new_v4() }),
    )
    .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "succeeded",
            "summary": "Built the comparison page from the two pages the browser read.",
            "artifacts": [run_log_with_usage()],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_charged_its_tokens(&fixture).await?;
    fixture.cleanup().await
}

/// The turn kept its reserve and paid for its 3,000 output tokens, as any
/// turn that replies does.
async fn assert_charged_its_tokens(fixture: &ReservedManagedAiPrompt) -> anyhow::Result<()> {
    let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
    let reasons = reasons(&rows);
    assert!(reasons.contains(&("managed_ai_adjustment", -1)), "{rows:?}");
    assert!(
        !reasons
            .iter()
            .any(|(reason, _)| *reason == "managed_ai_refund"),
        "{rows:?}"
    );
    assert_eq!(
        credit_balance(&fixture.pool, &fixture.org_id).await?,
        fixture.reserved_balance - 1
    );
    Ok(())
}

/// Only an evaluation turn's decline posts nothing. Any other turn that ends
/// on the decline word posts it as its message, so the word is a reply: a
/// hand-back cannot do its work and then end on it for free.
#[tokio::test]
async fn a_hand_back_that_ends_on_the_decline_word_costs_its_tokens() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-decline-word").await? else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        crate::browser_hand_back::HAND_BACK_KEY,
        json!({ "version": 1, "browserJobId": Uuid::new_v4() }),
    )
    .await?;
    // The fixture's prompt went to its group chat as an evaluation turn; a
    // hand-back is an ordinary one.
    fixture
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs set payload = payload #- '{metadata,groupParticipation}'
              where id = $1",
            &[&fixture.job_id],
        )
        .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "succeeded",
            "summary": crate::group_participation::DECLINE_SENTINEL,
            "artifacts": [run_log_with_usage()],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_charged_its_tokens(&fixture).await?;
    fixture.cleanup().await
}

/// An automatic retry of a group chat's evaluation turn that declines posts
/// nothing: it ended without a reply, so it costs nothing.
#[tokio::test]
async fn an_automatic_retry_that_declines_as_an_evaluation_costs_nothing() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-evaluation-decline").await?
    else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        AUTOMATIC_RETRY_KEY,
        json!({ "version": 1, "failedRunId": Uuid::new_v4() }),
    )
    .await?;
    stamp(
        &fixture,
        "groupParticipation",
        crate::group_participation::agent_evaluation_marker(),
    )
    .await?;
    let status = complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "succeeded",
            "summary": crate::group_participation::DECLINE_SENTINEL,
            "artifacts": [run_log_with_usage()],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_given_back(&fixture).await?;
    fixture.cleanup().await
}

/// Stopping a turn Instafy started gives its reserve back, even after a
/// runtime held it.
#[tokio::test]
async fn stopping_a_turn_instafy_started_gives_its_reserve_back() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-stopped").await? else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        AUTOMATIC_RETRY_KEY,
        json!({ "version": 1, "failedRunId": Uuid::new_v4() }),
    )
    .await?;
    let mut connection = fixture.pool.get().await?;
    let conversation_id: Uuid = connection
        .query_one(
            "update agent_jobs set status = 'leased', lease_attempts = 1
              where id = $1
          returning conversation_id",
            &[&fixture.job_id],
        )
        .await?
        .get(0);
    let transaction = connection.transaction().await?;
    let cancellation = crate::conversations::cancel_jobs_with_notice(
        &fixture.config,
        &transaction,
        &fixture.project_id,
        &conversation_id,
        None,
        &[(fixture.job_id, Some(fixture.run_id))],
        "Stopped",
        None,
    )
    .await
    .map_err(|error| controller_error("stop", error))?;
    transaction.commit().await?;
    drop(connection);
    assert_eq!(cancellation.refunded_org_ids, vec![fixture.org_id]);
    assert_given_back(&fixture).await?;
    fixture.cleanup().await
}

/// In a group chat, a teammate's correct answer cancels Octo's turn on the
/// same sum (crate::group_participation). A turn Instafy started that is
/// canceled that way ends without Octo's reply too, so its reserve comes back.
#[tokio::test]
async fn a_turn_instafy_started_that_a_teammates_answer_covers_gives_its_reserve_back(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-covered").await? else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        AUTOMATIC_RETRY_KEY,
        json!({ "version": 1, "failedRunId": Uuid::new_v4() }),
    )
    .await?;
    let mut connection = fixture.pool.get().await?;
    let conversation_id: Uuid = connection
        .query_one(
            "update agent_jobs
                set status = 'leased', lease_attempts = 1, intent = 'feature',
                    payload = jsonb_set(payload, '{metadata,agent}', '{\"handle\": \"octo\"}'::jsonb, true)
              where id = $1
          returning conversation_id",
            &[&fixture.job_id],
        )
        .await?
        .get(0);
    let transaction = connection.transaction().await?;
    let canceled = crate::group_participation::cancel_covered_default_octo_job(
        &transaction,
        &fixture.project_id,
        &conversation_id,
        crate::group_participation::ArithmeticCoverage {
            action: crate::group_participation::ArithmeticCoverageAction::CancelActiveOcto,
            message_id: Uuid::new_v4(),
            run_id: fixture.run_id,
            job_id: fixture.job_id,
        },
    )
    .await
    .map_err(|error| controller_error("cancel a covered turn", error))?;
    transaction.commit().await?;
    drop(connection);
    assert_eq!(
        canceled.map(|canceled| canceled.refunded_org_id),
        Some(Some(fixture.org_id))
    );
    assert_given_back(&fixture).await?;
    fixture.cleanup().await
}

/// A turn Instafy started whose job expires gives its reserve back, even
/// though a runtime held it, which keeps the charge of a turn someone sent.
#[tokio::test]
async fn an_expired_turn_instafy_started_gives_its_reserve_back() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-expired").await? else {
        eprintln!("skipping system turn billing test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    stamp(
        &fixture,
        crate::browser_hand_back::HAND_BACK_KEY,
        json!({ "version": 1, "browserJobId": Uuid::new_v4() }),
    )
    .await?;
    let mut connection = fixture.pool.get().await?;
    let payload: PgJson<serde_json::Value> = connection
        .query_one(
            "select payload from agent_jobs where id = $1",
            &[&fixture.job_id],
        )
        .await?
        .get(0);
    let mut transaction = connection.transaction().await?;
    let refunded = crate::runtime::refund_managed_ai_reserve_for_expired_job(
        &mut transaction,
        &fixture.project_id,
        &fixture.job_id,
        Some(fixture.run_id),
        1,
        &payload.0,
        "runtime_not_ready",
    )
    .await?;
    transaction.commit().await?;
    drop(connection);
    assert_eq!(refunded, Some(fixture.org_id));
    assert_given_back(&fixture).await?;
    fixture.cleanup().await
}

/// What the failed turn was asked.
const FAILED_PROMPT: &str = "Compare the three latest robot vacuums.";

/// One conversation of `owner`'s with a failed turn whose final message the
/// resends name.
struct FailedTurn {
    pool: PgPool,
    state: AppState,
    project_id: Uuid,
    conversation_id: Uuid,
    owner: Uuid,
    teammate: Uuid,
    failed_run_id: Uuid,
    failure_message_id: Uuid,
}

impl FailedTurn {
    async fn seed(&self, minutes_ago: i32) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        let prompt_id = Uuid::new_v4();
        connection
            .execute(
                "insert into prompts (id, project_id, conversation_id, user_id, prompt_text, created_at)
                 values ($1, $2, $3, $4, $5,
                         now() - make_interval(mins => $6) - interval '1 minute')",
                &[
                    &prompt_id,
                    &self.project_id,
                    &self.conversation_id,
                    &self.owner,
                    &FAILED_PROMPT,
                    &minutes_ago,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, prompt_id, conversation_id, run_type, status)
                 values ($1, $2, $3, $4, 'prompt', 'failed')",
                &[
                    &self.failed_run_id,
                    &self.project_id,
                    &prompt_id,
                    &self.conversation_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages
                     (id, conversation_id, project_id, prompt_id, run_id, role, content, metadata, created_at)
                 values ($1, $2, $3, $4, $5, 'assistant', 'Instafy AI isn''t answering right now.',
                         '{\"outcome\": \"failed\"}'::jsonb, now() - make_interval(mins => $6))",
                &[
                    &self.failure_message_id,
                    &self.conversation_id,
                    &self.project_id,
                    &prompt_id,
                    &self.failed_run_id,
                    &minutes_ago,
                ],
            )
            .await?;
        Ok(())
    }

    /// The resend Studio sends by itself, from `user`, with `extra` metadata:
    /// the failed prompt's own words.
    async fn resend(
        &self,
        user: &Uuid,
        extra: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.resend_words(user, FAILED_PROMPT, extra).await
    }

    /// A send from `user` of `words` with `extra` metadata; the metadata its
    /// job got.
    async fn resend_words(
        &self,
        user: &Uuid,
        words: &str,
        extra: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let mut metadata = extra;
        metadata["clientMessageId"] = json!(Uuid::new_v4().to_string());
        metadata["agentSelection"] = json!({ "active": ["octo"], "mentions": ["octo"] });
        let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
            project_id: Some(self.project_id.to_string()),
            session_id: None,
            prompt_text: Some(words.to_string()),
            intent: Some("feature".to_string()),
            plan_seed: None,
            metadata: Some(metadata),
            conversation_metadata: Some(json!({ "visibility": "public" })),
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
        .map_err(|error| controller_error("normalize resend", error))?;
        let context = RequestContext {
            user_id: Some(*user),
            is_service_role: false,
            scoped_claims: None,
        };
        let response = dispatch::process_dispatch_prompt(&self.state, &context, request)
            .await
            .map_err(|error| controller_error("resend", error))?;
        let prompt_id = response.prompt_id.context("prompt id")?;
        let payload: PgJson<serde_json::Value> = self
            .pool
            .get()
            .await?
            .query_one(
                "select payload from agent_jobs where prompt_id = $1",
                &[&prompt_id],
            )
            .await?
            .get(0);
        Ok(payload.0["metadata"].clone())
    }

    fn automatic(&self) -> serde_json::Value {
        json!({
            "retryAutomatic": true,
            "retryOfMessageId": self.failure_message_id.to_string(),
        })
    }

    /// Ends the conversation's turns, so the next send is not queued behind
    /// a busy lane.
    async fn settle(&self) -> anyhow::Result<()> {
        self.pool
            .get()
            .await?
            .execute(
                "update agent_jobs set status = 'completed', outcome = 'succeeded'
                  where conversation_id = $1 and status in ('queued', 'leased')",
                &[&self.conversation_id],
            )
            .await?;
        Ok(())
    }
}

async fn with_failed_turn(
    label: &str,
    minutes_ago: i32,
    body: impl for<'a> FnOnce(
        &'a FailedTurn,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<()>> + 'a>,
    >,
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(label).await?;
    let org_id = Uuid::new_v4();
    let turn = FailedTurn {
        state: build_test_state(
            pool.clone(),
            build_app_config(test_origin_private_key(), test_origin_public_key(), label),
        ),
        pool: pool.clone(),
        project_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
        owner: Uuid::new_v4(),
        teammate: Uuid::new_v4(),
        failed_run_id: Uuid::new_v4(),
        failure_message_id: Uuid::new_v4(),
    };
    ensure_test_user(&pool, &turn.owner).await?;
    ensure_test_user(&pool, &turn.teammate).await?;
    let result = with_shared_db_fixture(
        SharedDbFixture {
            organizations: vec![org_id],
            projects: vec![turn.project_id],
        },
        async {
            seed_group_participation_project(
                &pool,
                &org_id,
                &turn.project_id,
                &turn.owner,
                &turn.teammate,
                label,
            )
            .await?;
            pool.get()
                .await?
                .execute(
                    "insert into conversations (id, project_id, created_by, visibility)
                     values ($1, $2, $3, 'public')",
                    &[&turn.conversation_id, &turn.project_id, &turn.owner],
                )
                .await?;
            // Direct dispatch needs usable AI access before it queues: the
            // inert BYOC fixture, which no runtime or provider ever reads.
            for user in [&turn.owner, &turn.teammate] {
                pool.get()
                    .await?
                    .execute(
                        "insert into user_credentials (
                             id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                         ) values ($1, $2, 'openai_api_key', 'Automatic retry test',
                             'test-nonce', 'test-ciphertext', '{}'::jsonb, true)",
                        &[&Uuid::new_v4(), user],
                    )
                    .await?;
            }
            turn.seed(minutes_ago).await?;
            body(&turn).await
        },
    )
    .await;
    let owner_cleanup = cleanup_test_user(&pool, &turn.owner).await;
    let teammate_cleanup = cleanup_test_user(&pool, &turn.teammate).await;
    result?;
    owner_cleanup?;
    teammate_cleanup?;
    Ok(())
}

/// Studio's resend of a failed turn is stamped as Instafy's own only when its
/// failure checks out, and only once.
#[tokio::test]
async fn an_automatic_retry_is_stamped_once_and_only_for_its_senders_recent_failure(
) -> anyhow::Result<()> {
    with_failed_turn("automatic-retry-stamp", 0, |turn| {
        Box::pin(async move {
            // A teammate cannot resend someone else's failure as Instafy's.
            let teammate = turn.resend(&turn.teammate, turn.automatic()).await?;
            assert!(teammate.get(AUTOMATIC_RETRY_KEY).is_none(), "{teammate}");
            // That send came after the failure, so nothing is stamped now.
            turn.settle().await?;
            let late = turn.resend(&turn.owner, turn.automatic()).await?;
            assert!(late.get(AUTOMATIC_RETRY_KEY).is_none(), "{late}");
            Ok(())
        })
    })
    .await?;

    with_failed_turn("automatic-retry-stamp-owner", 0, |turn| {
        Box::pin(async move {
            // "Try again" pressed by the person is their own turn.
            let manual = turn
                .resend(
                    &turn.owner,
                    json!({ "retryOfMessageId": turn.failure_message_id.to_string() }),
                )
                .await?;
            assert!(manual.get(AUTOMATIC_RETRY_KEY).is_none(), "{manual}");
            Ok(())
        })
    })
    .await?;

    with_failed_turn("automatic-retry-stamp-first", 0, |turn| {
        Box::pin(async move {
            let mut claim = turn.automatic();
            // A client's copy of the stamp never survives.
            claim[AUTOMATIC_RETRY_KEY] = json!({ "version": 1, "failedRunId": Uuid::new_v4() });
            let metadata = turn.resend(&turn.owner, claim).await?;
            assert_eq!(
                metadata[AUTOMATIC_RETRY_KEY],
                json!({
                    "version": 1,
                    "failureMessageId": turn.failure_message_id,
                    "failedRunId": turn.failed_run_id,
                }),
                "{metadata}"
            );
            // Once per failure.
            turn.settle().await?;
            let again = turn.resend(&turn.owner, turn.automatic()).await?;
            assert!(again.get(AUTOMATIC_RETRY_KEY).is_none(), "{again}");
            Ok(())
        })
    })
    .await?;

    // Studio resends a failure by itself only within ten minutes.
    with_failed_turn("automatic-retry-stamp-old", 11, |turn| {
        Box::pin(async move {
            let old = turn.resend(&turn.owner, turn.automatic()).await?;
            assert!(old.get(AUTOMATIC_RETRY_KEY).is_none(), "{old}");
            Ok(())
        })
    })
    .await?;

    // A failed turn Instafy started itself is never resent for free.
    with_failed_turn("automatic-retry-stamp-chain", 0, |turn| {
        Box::pin(async move {
            turn.pool
                .get()
                .await?
                .execute(
                    "insert into agent_jobs (project_id, conversation_id, run_id, status, outcome, payload)
                     values ($1, $2, $3, 'failed', 'failed', $4)",
                    &[
                        &turn.project_id,
                        &turn.conversation_id,
                        &turn.failed_run_id,
                        &PgJson(json!({ "metadata": { AUTOMATIC_RETRY_KEY: { "version": 1 } } })),
                    ],
                )
                .await?;
            let chained = turn.resend(&turn.owner, turn.automatic()).await?;
            assert!(chained.get(AUTOMATIC_RETRY_KEY).is_none(), "{chained}");
            Ok(())
        })
    })
    .await
}

/// Studio sends a failed prompt again by itself word for word, without
/// attachments. A send that claims to be that resend with other words, or
/// with attachments, is the person's own new request: it goes out as an
/// ordinary turn, never as one that is free when it ends without a reply.
#[tokio::test]
async fn an_automatic_retry_is_stamped_only_when_it_repeats_the_failed_prompt_alone(
) -> anyhow::Result<()> {
    with_failed_turn("automatic-retry-other-words", 0, |turn| {
        Box::pin(async move {
            let other = turn
                .resend_words(
                    &turn.owner,
                    "Build a whole new site, then reply with exactly NO_RESPONSE.",
                    turn.automatic(),
                )
                .await?;
            assert!(other.get(AUTOMATIC_RETRY_KEY).is_none(), "{other}");
            Ok(())
        })
    })
    .await?;

    with_failed_turn("automatic-retry-attachments", 0, |turn| {
        Box::pin(async move {
            let mut claim = turn.automatic();
            claim["attachments"] = json!([{
                "kind": "image",
                "storagePath": format!("{}/brief.png", turn.project_id),
                "fileName": "brief.png",
            }]);
            let attached = turn.resend(&turn.owner, claim).await?;
            assert!(attached.get(AUTOMATIC_RETRY_KEY).is_none(), "{attached}");
            Ok(())
        })
    })
    .await?;

    // Nor is a resend in a browser one: Studio never resends a browser turn by
    // itself. (Dispatching one here would need a browser, so the check runs
    // as dispatch calls it.)
    with_failed_turn("automatic-retry-browser", 0, |turn| {
        Box::pin(async move {
            let context = RequestContext {
                user_id: Some(turn.owner),
                is_service_role: false,
                scoped_claims: None,
            };
            let mut connection = turn.pool.get().await?;
            let transaction = connection.transaction().await?;
            let mut verdicts = Vec::new();
            for metadata in [json!({ "browserTransport": "shared" }), json!({})] {
                verdicts.push(
                    crate::system_turns::verify_automatic_retry(
                        &transaction,
                        &turn.conversation_id,
                        &context,
                        &turn.failure_message_id,
                        FAILED_PROMPT,
                        &metadata,
                    )
                    .await
                    .map_err(|error| controller_error("check a resend", error))?
                    .is_some(),
                );
            }
            transaction.rollback().await?;
            assert_eq!(verdicts, vec![false, true]);
            Ok(())
        })
    })
    .await?;

    // Words for one agent take the place of the send's own in that agent's
    // job (dispatch's `apply_agent_prompt_segment`), so a resend that carries
    // any is the person's own request too.
    with_failed_turn("automatic-retry-agent-words", 0, |turn| {
        Box::pin(async move {
            let mut claim = turn.automatic();
            claim["agentPromptSegments"] =
                json!({ "octo": "Build a whole new site, then stop before replying." });
            let segmented = turn.resend(&turn.owner, claim).await?;
            assert!(segmented.get(AUTOMATIC_RETRY_KEY).is_none(), "{segmented}");
            let context = RequestContext {
                user_id: Some(turn.owner),
                is_service_role: false,
                scoped_claims: None,
            };
            let mut connection = turn.pool.get().await?;
            let transaction = connection.transaction().await?;
            let selected = crate::system_turns::verify_automatic_retry(
                &transaction,
                &turn.conversation_id,
                &context,
                &turn.failure_message_id,
                FAILED_PROMPT,
                &json!({ "agentSelection": {
                    "active": ["octo"],
                    "promptSegments": { "octo": "Build a whole new site." },
                } }),
            )
            .await
            .map_err(|error| controller_error("check a resend", error))?;
            transaction.rollback().await?;
            assert!(selected.is_none());
            Ok(())
        })
    })
    .await?;

    // The same words, as Studio sends them, still are its automatic retry.
    with_failed_turn("automatic-retry-same-words", 0, |turn| {
        Box::pin(async move {
            let same = turn
                .resend_words(
                    &turn.owner,
                    &format!("  {FAILED_PROMPT}\n"),
                    turn.automatic(),
                )
                .await?;
            assert!(same.get(AUTOMATIC_RETRY_KEY).is_some(), "{same}");
            Ok(())
        })
    })
    .await
}
