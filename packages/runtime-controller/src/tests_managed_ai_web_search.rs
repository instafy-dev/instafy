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
    seed_reserved_managed_ai_prompt, ReservedManagedAiPrompt,
};

/// The turn's run log as its runtime reports it: 3,000 output tokens (2 credits against the
/// 1-credit reserve) and, beside them, what its two web searches cost.
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
                "webSearch": {"searches": 2, "input_tokens": 16824, "cached_input_tokens": 0,
                              "output_tokens": 782},
            }],
        }],
    })
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
