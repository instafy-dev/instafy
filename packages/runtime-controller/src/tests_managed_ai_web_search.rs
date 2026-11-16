//! An Instafy AI turn's web searches are charged with the turn, on its message, in a row of their
//! own that Credits names "Web search". A person's own AI connection pays no credits for them.

use std::panic::AssertUnwindSafe;

use axum::http::StatusCode;
use futures_util::FutureExt;
use serde_json::json;
use tower::ServiceExt;

use crate::agent;
use crate::credits::{charge_managed_ai_web_searches, ManagedAiWebSearchUsage};
use crate::tests_managed_ai_refund::{
    agent_complete_request, credit_balance, ledger_metadata_by_key, ledger_rows,
    post_agent_message, seed_reserved_managed_ai_prompt, ReservedManagedAiPrompt,
};

/// What the job's two web searches cost, as its completion carries it (runtime-agent
/// `managed_web_search`): two searches that read 16,824 tokens of pages and wrote 782.
fn two_searches() -> serde_json::Value {
    json!({"kind": "ai/web-search-usage", "searches": 2, "input_tokens": 16824,
           "cached_input_tokens": 0, "output_tokens": 782})
}

/// The turn's run log as its runtime reports it: 3,000 output tokens (2 credits against the
/// 1-credit reserve), and what its two web searches cost.
fn completion_with_two_searches(fixture: &ReservedManagedAiPrompt) -> serde_json::Value {
    json!({
        "job_id": fixture.job_id,
        "outcome": "succeeded",
        "summary": "The museum is open this Sunday from 10:00 to 18:00.",
        "artifacts": [{
            "kind": "codex/run-log",
            "events": [{
                "type": "turn.completed",
                "usageScope": "turn",
                "usage": {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 3000},
            }],
        }, two_searches()],
    })
}

/// The step the room shows for a search that ran, as the runtime streams it.
fn search_step(fixture: &ReservedManagedAiPrompt) -> serde_json::Value {
    json!({
        "job_id": fixture.job_id,
        "content": "Web search completed: \"Kunsthistorisches Museum opening hours\"",
        "message_type": "web_search",
        "metadata": {
            "kind": "codex_web_search",
            "itemId": "ws_1",
            "eventType": "item.completed",
            "query": "Kunsthistorisches Museum opening hours",
            "status": "completed",
        },
    })
}

/// The web search rows of the fixture's project.
async fn web_search_rows(
    fixture_pool: &crate::config::PgPool,
    project_id: &uuid::Uuid,
) -> anyhow::Result<Vec<(String, i32, Option<String>)>> {
    Ok(ledger_rows(fixture_pool, project_id)
        .await?
        .into_iter()
        .filter(|(reason, _, _)| reason == "managed_ai_web_search")
        .collect())
}

async fn complete(
    fixture: &ReservedManagedAiPrompt,
    body: serde_json::Value,
) -> anyhow::Result<StatusCode> {
    let request = agent_complete_request(fixture, body).await?;
    Ok(agent::router()
        .with_state(fixture.state.clone())
        .oneshot(request)
        .await?
        .status())
}

async fn with_cleanup(
    fixture: ReservedManagedAiPrompt,
    test: impl std::future::Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let outcome = AssertUnwindSafe(test).catch_unwind().await;
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

/// Two searches that read 16,824 tokens of pages and wrote 782: 20,000 micro-dollars for the
/// searches and 2,074 for their tokens, 23 credits, in one "Web search" row on the message, once.
#[tokio::test]
async fn a_turns_web_searches_are_charged_once_on_its_message() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("web-search-charge").await? else {
        eprintln!("skipping web search charge test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let pool = fixture.pool.clone();
    let config = fixture.config.clone();
    let (org_id, project_id, prompt_id, job_id) = (
        fixture.org_id,
        fixture.project_id,
        fixture.prompt_id,
        fixture.job_id,
    );
    let reserved_balance = fixture.reserved_balance;
    let body = completion_with_two_searches(&fixture);
    let status = complete(&fixture, body).await;
    with_cleanup(fixture, async move {
        assert_eq!(status?, StatusCode::OK);
        let key = format!("managed-ai-web-search:{prompt_id}:{job_id}");
        let rows = ledger_rows(&pool, &project_id).await?;
        let searches = rows
            .iter()
            .filter(|(reason, _, _)| reason == "managed_ai_web_search")
            .collect::<Vec<_>>();
        assert_eq!(
            searches,
            vec![&("managed_ai_web_search".to_string(), -23, Some(key.clone()))],
            "{rows:?}"
        );
        // The turn's tokens settle the reserve as before, apart from the searches.
        assert_eq!(
            credit_balance(&pool, &org_id).await?,
            reserved_balance - 1 - 23
        );
        let metadata = ledger_metadata_by_key(&pool, &project_id, &key).await?;
        assert_eq!(metadata["promptId"], json!(prompt_id));
        assert_eq!(metadata["jobId"], json!(job_id));
        assert_eq!(metadata["webSearch"]["searches"], 2);
        assert_eq!(metadata["webSearch"]["usage"]["input_tokens"], 16824);
        assert_eq!(metadata["pricing"]["webSearchUsdMicrosPerSearch"], 10_000);
        assert_eq!(metadata["cost"]["searchesUsdMicros"], 20_000);
        assert_eq!(metadata["cost"]["tokensUsdMicros"], 2_074);
        assert_eq!(metadata["cost"]["chargedUnits"], 23);

        // A completion settled again takes the same key and charges nothing more.
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let again = charge_managed_ai_web_searches(
            &transaction,
            &config,
            &project_id,
            &org_id,
            None,
            &prompt_id,
            &job_id,
            ManagedAiWebSearchUsage {
                searches: 2,
                input_tokens: 16824,
                cached_input_tokens: 0,
                output_tokens: 782,
            },
        )
        .await
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        transaction.commit().await?;
        assert!(!again.ledger_row_written);
        assert_eq!(
            ledger_rows(&pool, &project_id)
                .await?
                .iter()
                .filter(|(reason, _, _)| reason == "managed_ai_web_search")
                .count(),
            1
        );
        assert_eq!(
            credit_balance(&pool, &org_id).await?,
            reserved_balance - 1 - 23
        );
        anyhow::Ok(())
    })
    .await
}

/// A turn on the person's own AI connection is never charged credits for its searches, whatever
/// its run log says.
#[tokio::test]
async fn an_own_connections_web_searches_cost_no_credits() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("web-search-own").await? else {
        eprintln!("skipping own connection web search test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    // Dispatch marks a job on the person's own connection `managedAiUsed: false`.
    fixture
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs
                set payload = jsonb_set(payload, '{metadata,managedAiUsed}', 'false'::jsonb)
              where id = $1",
            &[&fixture.job_id],
        )
        .await?;
    let pool = fixture.pool.clone();
    let (org_id, project_id) = (fixture.org_id, fixture.project_id);
    let reserved_balance = fixture.reserved_balance;
    let body = completion_with_two_searches(&fixture);
    let status = complete(&fixture, body).await;
    with_cleanup(fixture, async move {
        assert_eq!(status?, StatusCode::OK);
        let rows = ledger_rows(&pool, &project_id).await?;
        assert!(
            !rows
                .iter()
                .any(|(reason, _, _)| reason == "managed_ai_web_search"),
            "{rows:?}"
        );
        assert_eq!(credit_balance(&pool, &org_id).await?, reserved_balance);
        anyhow::Ok(())
    })
    .await
}

/// A turn that searched and then ended in an error (or its time limit) has no `turn.completed`,
/// so nothing of its tokens is reconciled; its searches ran and OpenAI billed them, so they are
/// charged all the same, from the job's report of what they cost. The search step is a step that
/// worked, so the turn keeps its reserve too.
#[tokio::test]
async fn a_failed_turns_web_searches_are_charged() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("web-search-failed").await? else {
        eprintln!("skipping failed turn web search test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let step = post_agent_message(&fixture, search_step(&fixture)).await;
    let pool = fixture.pool.clone();
    let (org_id, project_id, prompt_id, job_id) = (
        fixture.org_id,
        fixture.project_id,
        fixture.prompt_id,
        fixture.job_id,
    );
    let reserved_balance = fixture.reserved_balance;
    let body = json!({
        "job_id": fixture.job_id,
        "outcome": "failed",
        "error_message": "stream disconnected before completion: error sending request for url (http://proxy:8789/v1/responses)",
        // The run log of the events streamed so far: the search, and no turn.completed.
        "artifacts": [{
            "kind": "codex/run-log",
            "events": [{"type": "item.completed",
                        "item": {"id": "ws_1", "type": "web_search",
                                 "query": "Kunsthistorisches Museum opening hours"}}],
        }, two_searches()],
    });
    let status = complete(&fixture, body).await;
    with_cleanup(fixture, async move {
        assert_eq!(step?, StatusCode::OK);
        assert_eq!(status?, StatusCode::OK);
        let key = format!("managed-ai-web-search:{prompt_id}:{job_id}");
        assert_eq!(
            web_search_rows(&pool, &project_id).await?,
            vec![("managed_ai_web_search".to_string(), -23, Some(key))]
        );
        assert_eq!(credit_balance(&pool, &org_id).await?, reserved_balance - 23);
        anyhow::Ok(())
    })
    .await
}

/// An ambient evaluation on Instafy AI is billed only once it speaks, and one that declines costs
/// nothing for its tokens. Its web searches ran on the platform's key all the same, so they are
/// charged even when it then declined: no search is free.
#[tokio::test]
async fn a_declined_evaluations_web_searches_are_charged() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("web-search-declined").await? else {
        eprintln!("skipping declined evaluation web search test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    // As dispatch leaves a skill-mode ambient evaluation on Instafy AI: its billing waits for it
    // to speak, so it is not marked used.
    fixture
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs
                set payload = jsonb_set(payload, '{metadata}', payload -> 'metadata' || $2::jsonb)
              where id = $1",
            &[
                &fixture.job_id,
                &tokio_postgres::types::Json(json!({
                    "managedAiUsed": false,
                    "managedAiBillingDeferred": true,
                    "groupParticipation": {
                        "decision": "agent_evaluation",
                        "reason": "skill_mode_ambient",
                        "enforcedBy": "runtime-controller",
                    },
                })),
            ],
        )
        .await?;
    let pool = fixture.pool.clone();
    let (project_id, prompt_id, job_id) = (fixture.project_id, fixture.prompt_id, fixture.job_id);
    let mut body = completion_with_two_searches(&fixture);
    body["summary"] = json!("NO_RESPONSE");
    let status = complete(&fixture, body).await;
    with_cleanup(fixture, async move {
        assert_eq!(status?, StatusCode::OK);
        let key = format!("managed-ai-web-search:{prompt_id}:{job_id}");
        assert_eq!(
            web_search_rows(&pool, &project_id).await?,
            vec![("managed_ai_web_search".to_string(), -23, Some(key))]
        );
        anyhow::Ok(())
    })
    .await
}
