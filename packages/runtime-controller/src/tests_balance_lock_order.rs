//! Writers that burn, refund or give back a managed-AI reserve beside a
//! managed-AI dispatch, on the migrated database.
//!
//! A dispatch locks its conversation `for update`, then reserves the org's
//! credit, and its message then updates the conversation's root. A burn, a
//! refund or a give-back locks the org's balance, and its writer then writes
//! into its conversation, which updates the conversation, then its root
//! (`crate::agent::insert_agent_conversation_message`). A writer that waited
//! for the dispatch's conversation while it held the balance deadlocked with
//! it, and Postgres failed one side: the person's message, or the writer's
//! refund or reply. Each writer now locks its conversation and the root,
//! threads first (`crate::conversations::lock_conversations_for_writes`),
//! before the balance. Each test holds a managed-AI dispatch into the root
//! once it locked the root and before it reserves, runs the writer, and needs
//! both to finish without the writer holding the balance while it waits:
//!
//! - a completion in a thread whose failure refunds its reserve, and an
//!   automatic retry's completion that gives its reserve back;
//! - an ambient evaluation's first visible answer, which pays the reserve it
//!   deferred, at its completion and as a streamed message;
//! - a teammate's answer that covers Octo's turn, whose dispatch cancels the
//!   turn and gives its reserve back before it writes the answer.
//!
//! The last test holds a runtime alert naming the completing run between its
//! insert and its conversation's update. The completion holds the
//! conversation from its refund on, so it rewrites the run's metadata
//! `for no key update`: it never waits for the alert's key-share lock on the
//! run while the alert waits for the conversation. The old code passes it,
//! as it locked the conversation only for its reply; it guards the lock mode.
//!
//! The refused team plan's test is in `multi_agent_plan`.

use std::future::Future;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::config::PgPool;
use crate::dispatch::{DispatchPromptNormalized, DispatchPromptRequest, DispatchPromptResponse};
use crate::system_turns::SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON;
use crate::tests::spawn_aborting;
use crate::tests_lock_waits::{
    controller_error, run_messages, seen_waited_for, would_wait, DispatchFence, HeldRunMessage,
};
use crate::tests_managed_ai_refund::{
    ledger_metadata_by_key, ledger_rows, seed_reserved_managed_ai_prompt, ReservedManagedAiPrompt,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};

/// How long each side may take to finish once nothing holds it.
const FINISH_WITHIN: Duration = Duration::from_secs(20);

/// The proxy's refusal of a turn's request before any model answered: its
/// completion refunds the reserve.
const PROXY_REJECTED: &str = "unexpected status 401 Unauthorized: proxy token missing credential_id for BYOC request, url: http://proxy:8789/v1/responses";

/// A failure that says nothing of a refusal. A turn Instafy started by itself
/// that it ends left the person nothing, so it gives its reserve back.
const MACHINE_STOPPED: &str = "The machine running this turn stopped.";

/// The ambient evaluation's answer.
const EVALUATION_ANSWER: &str = "Blue reads better on the dark theme.";

/// Runs `test`, then removes the fixture's org, whose cascade takes the
/// project, its conversations and their runs, and the fixture's users,
/// whether the test returns or panics.
pub(crate) async fn on_the_fixtures_org(
    fixture: &ReservedManagedAiPrompt,
    test: impl Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    use futures_util::FutureExt;

    let outcome = std::panic::AssertUnwindSafe(test).catch_unwind().await;
    let cleanup = fixture.cleanup().await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => {
            if let Err(error) = cleanup {
                eprintln!(
                    "[runtime-controller tests] fixture cleanup failed after a panic: {error:#}"
                );
            }
            std::panic::resume_unwind(panic)
        }
    }
}

/// Adds a public child of the fixture's conversation, of `thread_kind`, and
/// returns it with its root, the fixture's conversation. A child of no kind
/// keeps the rules of a conversation people share: an unaddressed send is an
/// ambient turn, and a teammate's answer can cover Octo's.
pub(crate) async fn child_conversation(
    fixture: &ReservedManagedAiPrompt,
    thread_kind: Option<&str>,
) -> anyhow::Result<(Uuid, Uuid)> {
    let child = Uuid::new_v4();
    let root: Uuid = fixture
        .pool
        .get()
        .await?
        .query_one(
            "insert into conversations (
                 id, project_id, created_by, visibility,
                 parent_conversation_id, root_conversation_id, thread_kind
             )
             select $1, project_id, $2, 'public', id, id, $4
             from conversations
             where id = (select conversation_id from agent_jobs where id = $3)
             returning root_conversation_id",
            &[
                &child,
                &fixture.owner_user_id,
                &fixture.job_id,
                &thread_kind,
            ],
        )
        .await?
        .get(0);
    Ok((child, root))
}

/// Moves the fixture's managed-AI turn, its job, run and prompt, into
/// `conversation`. With `automatic_retry` it stamps the turn as one Instafy
/// started by itself, which costs nothing when it leaves the person nothing.
pub(crate) async fn move_turn_into(
    fixture: &ReservedManagedAiPrompt,
    conversation: Uuid,
    automatic_retry: bool,
) -> anyhow::Result<()> {
    let connection = fixture.pool.get().await?;
    connection
        .execute(
            "update agent_jobs
             set conversation_id = $2,
                 payload = case
                     when $4 then jsonb_set(
                         payload || jsonb_build_object('conversation_id', $3::text),
                         '{metadata,automaticRetry}',
                         '{\"version\": 1}'::jsonb,
                         true
                     )
                     else payload || jsonb_build_object('conversation_id', $3::text)
                 end
             where id = $1",
            &[
                &fixture.job_id,
                &conversation,
                &conversation.to_string(),
                &automatic_retry,
            ],
        )
        .await?;
    connection
        .execute(
            "update runs set conversation_id = $2 where id = $1",
            &[&fixture.run_id, &conversation],
        )
        .await?;
    connection
        .execute(
            "update prompts set conversation_id = $2 where id = $1",
            &[&fixture.prompt_id, &conversation],
        )
        .await?;
    Ok(())
}

/// How a writer under test and the dispatch held beside it ended.
pub(crate) struct BesideHeldDispatch<T> {
    /// Whether the writer held the org's balance while it waited for the
    /// dispatch.
    pub(crate) balance_held: bool,
    pub(crate) dispatched: anyhow::Result<DispatchPromptResponse>,
    pub(crate) written: anyhow::Result<T>,
}

/// Holds the owner's managed-AI dispatch into `into` at its fence, once it
/// locked `into` `for update` and before it reserves the org's credit, and
/// starts `writer`. Once the writer waits for the dispatch, it finds out
/// whether the writer holds the org's balance, lets the dispatch go, and
/// returns how both ended.
pub(crate) async fn beside_a_held_dispatch<T: Send + 'static>(
    fixture: &ReservedManagedAiPrompt,
    into: Uuid,
    writer: impl Future<Output = anyhow::Result<T>> + Send + 'static,
) -> anyhow::Result<BesideHeldDispatch<T>> {
    let pool = &fixture.pool;
    let fence = DispatchFence::hold(into).await?;
    let (dispatching, dispatch_pid) = fence
        .held_dispatch(
            &fixture.state,
            fixture.project_id,
            fixture.owner_user_id,
            "and the green one?",
        )
        .await?;
    // Aborted if this returns early, so it never outlives the test.
    let writing = spawn_aborting(writer);
    anyhow::ensure!(
        seen_waited_for(pool, &writing, dispatch_pid).await?,
        "the writer never waited for the dispatch's conversation"
    );
    let balance_held = would_wait(
        pool,
        "org_credit_balances",
        "org_id",
        fixture.org_id,
        "share",
    )
    .await?;
    fence.release().await?;
    let dispatched = tokio::time::timeout(FINISH_WITHIN, dispatching).await??;
    let written = tokio::time::timeout(FINISH_WITHIN, writing).await??;
    Ok(BesideHeldDispatch {
        balance_held,
        dispatched,
        written,
    })
}

/// Whether the ledger of `project_id` holds the managed-AI reserve of
/// `prompt_id`.
pub(crate) async fn reserved(
    pool: &PgPool,
    project_id: Uuid,
    prompt_id: Option<Uuid>,
) -> anyhow::Result<bool> {
    let Some(prompt_id) = prompt_id else {
        return Ok(false);
    };
    let reserve_key = format!("managed-ai-prompt:{prompt_id}");
    Ok(ledger_rows(pool, &project_id)
        .await?
        .iter()
        .any(|(_, _, key)| key.as_deref() == Some(reserve_key.as_str())))
}

/// Why the reserve of `prompt_id` was given back, or None while it is not.
pub(crate) async fn refund_reason(
    pool: &PgPool,
    project_id: Uuid,
    prompt_id: Uuid,
) -> anyhow::Result<Option<serde_json::Value>> {
    let refund_key = format!("managed-ai-refund:{prompt_id}");
    if !ledger_rows(pool, &project_id)
        .await?
        .iter()
        .any(|(_, _, key)| key.as_deref() == Some(refund_key.as_str()))
    {
        return Ok(None);
    }
    Ok(Some(
        ledger_metadata_by_key(pool, &project_id, &refund_key).await?["refundReason"].clone(),
    ))
}

/// Leases `job` and builds the runtime's request to the agent route `uri`,
/// with a token for `scope`.
async fn runtime_request(
    fixture: &ReservedManagedAiPrompt,
    job: Uuid,
    uri: &str,
    scope: &str,
    body: serde_json::Value,
) -> anyhow::Result<Request<Body>> {
    fixture
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs set status = 'leased' where id = $1",
            &[&job],
        )
        .await?;
    let token = mint_scoped_token(
        &fixture.config,
        ScopedTokenRequest {
            audience: fixture.project_id.to_string(),
            subject: "agent:balance-lock-order-test".to_string(),
            project_id: fixture.project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: None,
            scopes: vec![scope.to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("minting the runtime's token", error))?
    .token;
    Ok(Request::builder()
        .method("POST")
        .uri(uri)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))?)
}

/// Sends the runtime's `request` to the agent routes and returns its status.
async fn send(state: crate::AppState, request: Request<Body>) -> anyhow::Result<StatusCode> {
    Ok(crate::agent::router()
        .with_state(state)
        .oneshot(request)
        .await?
        .status())
}

/// A send of `prompt` into `conversation` that addresses no agent, as the
/// Studio's composer makes it.
fn unaddressed_send(
    project_id: Uuid,
    conversation: Uuid,
    prompt: &str,
) -> anyhow::Result<DispatchPromptNormalized> {
    crate::dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt.to_string()),
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
        conversation_id: Some(conversation.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalizing the send", error))
}

fn as_user(user_id: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(user_id),
        is_service_role: false,
        scoped_claims: None,
    }
}

/// How many messages of `run_id` `conversation` keeps.
async fn run_replies(pool: &PgPool, conversation: Uuid, run_id: Uuid) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages
              where conversation_id = $1 and run_id = $2 and role = 'assistant'",
            &[&conversation, &run_id],
        )
        .await?
        .get(0))
}

/// How many messages saying `content` `conversation` keeps.
async fn messages_saying(pool: &PgPool, conversation: Uuid, content: &str) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages
              where conversation_id = $1 and content = $2",
            &[&conversation, &content],
        )
        .await?
        .get(0))
}

/// Asserts that the writer never held the org's balance while it waited for
/// the dispatch, and that the dispatch went on to queue its prompt and
/// reserve its credit. Returns what the writer ended with.
async fn assert_both_finished<T>(
    fixture: &ReservedManagedAiPrompt,
    outcome: BesideHeldDispatch<T>,
    writer: &str,
) -> anyhow::Result<T> {
    assert!(
        !outcome.balance_held,
        "{writer} waits for the dispatch's conversation while it holds the org's balance"
    );
    let dispatched = outcome.dispatched?;
    assert_eq!(dispatched.status, "queued", "the prompt is queued");
    assert!(
        reserved(&fixture.pool, fixture.project_id, dispatched.prompt_id).await?,
        "the dispatch reserves the org's credit past its fence"
    );
    outcome.written
}

/// Runs the completion `body` of the fixture's turn, moved into a thread of
/// the fixture's conversation (with `automatic_retry`, as a turn Instafy
/// started by itself), beside a managed-AI dispatch into the root. Returns
/// the thread and how both ended.
async fn complete_in_a_thread_beside_a_root_dispatch(
    fixture: &ReservedManagedAiPrompt,
    automatic_retry: bool,
    body: serde_json::Value,
) -> anyhow::Result<(Uuid, BesideHeldDispatch<StatusCode>)> {
    let (thread, root) = child_conversation(fixture, Some("thread")).await?;
    move_turn_into(fixture, thread, automatic_retry).await?;
    let request = runtime_request(
        fixture,
        fixture.job_id,
        "/agent/complete",
        "agent.complete",
        body,
    )
    .await?;
    let outcome =
        beside_a_held_dispatch(fixture, root, send(fixture.state.clone(), request)).await?;
    Ok((thread, outcome))
}

#[tokio::test]
async fn a_refunded_completion_in_a_thread_and_a_dispatch_into_its_root_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("refund-beside-root-dispatch").await?
    else {
        eprintln!("skipping the refund beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        // The proxy refused the turn's request before any model answered.
        let (thread, outcome) = complete_in_a_thread_beside_a_root_dispatch(
            &fixture,
            false,
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": PROXY_REJECTED,
                "artifacts": [],
            }),
        )
        .await?;

        let status = assert_both_finished(&fixture, outcome, "the completion").await?;
        assert_eq!(status, StatusCode::OK, "the completion is stored");
        assert_eq!(
            refund_reason(pool, fixture.project_id, fixture.prompt_id).await?,
            Some(json!("proxy_auth_rejected")),
            "the completion refunds the refused turn's reserve"
        );
        assert_eq!(
            run_replies(pool, thread, fixture.run_id).await?,
            1,
            "the failed turn's reply is in the thread"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn an_automatic_retrys_completion_in_a_thread_and_a_dispatch_into_its_root_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("give-back-beside-root-dispatch").await?
    else {
        eprintln!("skipping the give-back beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        // The retry's machine stopped before it did anything.
        let (thread, outcome) = complete_in_a_thread_beside_a_root_dispatch(
            &fixture,
            true,
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": MACHINE_STOPPED,
                "artifacts": [],
            }),
        )
        .await?;

        let status = assert_both_finished(&fixture, outcome, "the completion").await?;
        assert_eq!(status, StatusCode::OK, "the completion is stored");
        assert_eq!(
            refund_reason(pool, fixture.project_id, fixture.prompt_id).await?,
            Some(json!(SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON)),
            "the retry that left nothing gives its reserve back"
        );
        assert_eq!(
            run_replies(pool, thread, fixture.run_id).await?,
            1,
            "the failed retry's reply is in the thread"
        );
        Ok(())
    })
    .await
}

/// An ambient evaluation in a child of the fixture's conversation, whose
/// managed-AI reserve waits for its first visible answer.
struct AmbientEvaluation {
    child: Uuid,
    root: Uuid,
    job: Uuid,
    prompt: Uuid,
}

/// Ends the fixture's own turn, then has its owner send a prompt that
/// addresses no agent into a new child of the fixture's conversation, which
/// both of the fixture's people can read. Octo evaluates whether to answer
/// it, and the dispatch reserves nothing until the answer shows.
async fn ambient_evaluation_in_a_child(
    fixture: &ReservedManagedAiPrompt,
) -> anyhow::Result<AmbientEvaluation> {
    let pool = &fixture.pool;
    let (child, root) = child_conversation(fixture, None).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "update agent_jobs
                 set status = 'canceled', outcome = 'canceled', completed_at = now()
                 where id = $1",
                &[&fixture.job_id],
            )
            .await?;
        connection
            .execute(
                "update runs set status = 'canceled' where id = $1",
                &[&fixture.run_id],
            )
            .await?;
    }
    let response = crate::dispatch::process_dispatch_prompt(
        &fixture.state,
        &as_user(fixture.owner_user_id),
        unaddressed_send(
            fixture.project_id,
            child,
            "Which shade reads better on the dark theme?",
        )?,
    )
    .await
    .map_err(|error| controller_error("the ambient send", error))?;
    anyhow::ensure!(
        response.status == "queued",
        "the ambient send dispatches an evaluation, got {}",
        response.status
    );
    let connection = pool.get().await?;
    let row = connection
        .query_one(
            "select id, payload from agent_jobs where conversation_id = $1",
            &[&child],
        )
        .await?;
    let job: Uuid = row.get("id");
    let payload = row.get::<_, PgJson<serde_json::Value>>("payload").0;
    let prompt: Uuid = connection
        .query_one(
            "select id from prompts where conversation_id = $1",
            &[&child],
        )
        .await?
        .get("id");
    anyhow::ensure!(
        payload["metadata"]["managedAiBillingDeferred"] == json!(true)
            && payload["metadata"]["managedAiUsed"] != json!(true),
        "the evaluation's billing waits for its answer: {payload}"
    );
    anyhow::ensure!(
        !reserved(pool, fixture.project_id, Some(prompt)).await?,
        "the ambient send reserves nothing"
    );
    Ok(AmbientEvaluation {
        child,
        root,
        job,
        prompt,
    })
}

/// Runs the runtime's `body` to the agent route `uri`, the evaluation's
/// first visible answer, beside a managed-AI dispatch into the root of the
/// evaluation's conversation, and checks that both finish and the answer
/// pays the reserve it deferred.
async fn answer_beside_a_root_dispatch(
    fixture: &ReservedManagedAiPrompt,
    evaluation: &AmbientEvaluation,
    uri: &str,
    scope: &str,
    body: serde_json::Value,
) -> anyhow::Result<()> {
    let pool = &fixture.pool;
    let request = runtime_request(fixture, evaluation.job, uri, scope, body).await?;
    let outcome = beside_a_held_dispatch(
        fixture,
        evaluation.root,
        send(fixture.state.clone(), request),
    )
    .await?;

    let status = assert_both_finished(fixture, outcome, "the answer").await?;
    assert_eq!(status, StatusCode::OK, "the answer is stored");
    assert!(
        reserved(pool, fixture.project_id, Some(evaluation.prompt)).await?,
        "the evaluation's answer pays the reserve it deferred"
    );
    assert_eq!(
        messages_saying(pool, evaluation.child, EVALUATION_ANSWER).await?,
        1,
        "the answer is in the evaluation's conversation"
    );
    Ok(())
}

#[tokio::test]
async fn an_evaluations_answer_at_its_completion_and_a_dispatch_into_its_root_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) =
        seed_reserved_managed_ai_prompt("deferred-completion-beside-root-dispatch").await?
    else {
        eprintln!("skipping the deferred completion beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let evaluation = ambient_evaluation_in_a_child(&fixture).await?;
        answer_beside_a_root_dispatch(
            &fixture,
            &evaluation,
            "/agent/complete",
            "agent.complete",
            json!({
                "job_id": evaluation.job,
                "outcome": "succeeded",
                "summary": EVALUATION_ANSWER,
                "artifacts": [],
            }),
        )
        .await
    })
    .await
}

#[tokio::test]
async fn an_evaluations_streamed_answer_and_a_dispatch_into_its_root_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) =
        seed_reserved_managed_ai_prompt("deferred-message-beside-root-dispatch").await?
    else {
        eprintln!("skipping the deferred message beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let evaluation = ambient_evaluation_in_a_child(&fixture).await?;
        answer_beside_a_root_dispatch(
            &fixture,
            &evaluation,
            "/agent/message",
            "agent.message",
            json!({
                "job_id": evaluation.job,
                "content": EVALUATION_ANSWER,
                "message_type": "status",
                "metadata": { "kind": "agent_message" },
            }),
        )
        .await
    })
    .await
}

#[tokio::test]
async fn a_teammates_answer_covering_octos_turn_and_a_dispatch_into_its_root_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) =
        seed_reserved_managed_ai_prompt("covered-octo-beside-root-dispatch").await?
    else {
        eprintln!("skipping the covered Octo turn beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        // Octo's answer to the owner's sum, retried by Instafy, runs in a
        // child the owner and their teammate share.
        let (child, root) = child_conversation(&fixture, None).await?;
        move_turn_into(&fixture, child, true).await?;
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "update agent_jobs
                     set status = 'leased', lease_attempts = 1, intent = 'feature',
                         payload = jsonb_set(
                             payload, '{metadata,agent}', '{\"handle\": \"octo\"}'::jsonb, true
                         )
                     where id = $1",
                    &[&fixture.job_id],
                )
                .await?;
            connection
                .execute(
                    "insert into conversation_messages (
                         id, conversation_id, project_id, run_id, role, content, metadata,
                         created_by
                     ) values ($1, $2, $3, $4, 'user', 'What is 1 + 1?', '{}'::jsonb, $5)",
                    &[
                        &Uuid::new_v4(),
                        &child,
                        &fixture.project_id,
                        &fixture.run_id,
                        &fixture.owner_user_id,
                    ],
                )
                .await?;
        }

        // The teammate answers first. Their dispatch cancels Octo's turn,
        // which gives the retry's reserve back, and writes the answer into
        // the child, which updates the root.
        let answer = unaddressed_send(fixture.project_id, child, "It is 2")?;
        let (state, teammate) = (fixture.state.clone(), fixture.other_user_id);
        let outcome = beside_a_held_dispatch(&fixture, root, async move {
            crate::dispatch::process_dispatch_prompt(&state, &as_user(teammate), answer)
                .await
                .map_err(|error| controller_error("the teammate's answer", error))
        })
        .await?;

        let answered = assert_both_finished(&fixture, outcome, "the teammate's dispatch").await?;
        assert_eq!(
            answered.status, "recorded",
            "the teammate's answer is recorded without a turn"
        );
        let status: String = pool
            .get()
            .await?
            .query_one(
                "select status from agent_jobs where id = $1",
                &[&fixture.job_id],
            )
            .await?
            .get(0);
        assert_eq!(status, "canceled", "the answer covers Octo's turn");
        assert_eq!(
            refund_reason(pool, fixture.project_id, fixture.prompt_id).await?,
            Some(json!(SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON)),
            "the covered retry gives its reserve back"
        );
        assert_eq!(
            messages_saying(pool, child, "It is 2").await?,
            1,
            "the teammate's answer is in the child"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_refunded_completion_and_a_runtime_alert_naming_its_run_both_finish() -> anyhow::Result<()>
{
    let Some(fixture) = seed_reserved_managed_ai_prompt("refund-beside-run-message").await? else {
        eprintln!("skipping the refund beside a runtime alert: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        let chat: Uuid = pool
            .get()
            .await?
            .query_one(
                "select conversation_id from agent_jobs where id = $1",
                &[&fixture.job_id],
            )
            .await?
            .get(0);
        // The dispatch that started the turn committed and writes its runtime
        // alert, held between its insert, which holds a key-share lock on the
        // run, and its conversation's update.
        let message = HeldRunMessage::insert(
            fixture.project_id,
            chat,
            fixture.run_id,
            Some(fixture.prompt_id),
        )
        .await?;

        // The proxy refused the turn's request before any model answered.
        let request = runtime_request(
            &fixture,
            fixture.job_id,
            "/agent/complete",
            "agent.complete",
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": PROXY_REJECTED,
                "artifacts": [],
            }),
        )
        .await?;
        let completing = spawn_aborting(send(fixture.state.clone(), request));
        let waited = seen_waited_for(pool, &completing, message.pid).await?;
        let chat_held =
            waited && would_wait(pool, "conversations", "id", chat, "no key update").await?;
        let written = tokio::time::timeout(FINISH_WITHIN, message.finish()).await?;
        let completed = tokio::time::timeout(FINISH_WITHIN, completing).await?;

        assert!(
            !chat_held,
            "the completion waits for the alert while it holds the conversation"
        );
        written?;
        assert_eq!(completed??, StatusCode::OK, "the completion is stored");
        assert_eq!(run_messages(pool, chat).await?, 1, "the alert is kept");
        assert_eq!(
            refund_reason(pool, fixture.project_id, fixture.prompt_id).await?,
            Some(json!("proxy_auth_rejected")),
            "the completion refunds the refused turn's reserve"
        );
        Ok(())
    })
    .await
}
