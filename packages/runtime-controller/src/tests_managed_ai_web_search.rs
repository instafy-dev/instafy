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
/// nothing: nobody is charged for searches behind a check that did nothing. The proxy refuses
/// such a check its searches until it answers (`managed_web_search`), so a completion that still
/// reports some (from a proxy that did not ask) writes no "Web search" row either.
#[tokio::test]
async fn a_declined_evaluations_web_searches_are_not_charged() -> anyhow::Result<()> {
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
    let project_id = fixture.project_id;
    let mut body = completion_with_two_searches(&fixture);
    body["summary"] = json!("NO_RESPONSE");
    let status = complete(&fixture, body).await;
    with_cleanup(fixture, async move {
        assert_eq!(status?, StatusCode::OK);
        let rows = web_search_rows(&pool, &project_id).await?;
        assert!(rows.is_empty(), "{rows:?}");
        anyhow::Ok(())
    })
    .await
}

/// One of the proxy's checks before a managed job's searches: the job `(space, job, run)` as its
/// token names it, its lease attempt, and the check's own id.
#[derive(Debug, Clone, Copy)]
struct Check {
    job: (uuid::Uuid, uuid::Uuid, uuid::Uuid),
    lease_attempt: i32,
    id: uuid::Uuid,
}

impl Check {
    /// A new check of the job's first lease attempt.
    fn of(job: (uuid::Uuid, uuid::Uuid, uuid::Uuid)) -> Self {
        Self::of_attempt(job, 1)
    }

    fn of_attempt(job: (uuid::Uuid, uuid::Uuid, uuid::Uuid), lease_attempt: i32) -> Self {
        Self {
            job,
            lease_attempt,
            id: uuid::Uuid::new_v4(),
        }
    }

    fn body(&self, field: &str, value: u32) -> serde_json::Value {
        let (project_id, job_id, run_id) = self.job;
        let mut body = json!({"projectId": project_id, "jobId": job_id,
                              "leaseAttempt": self.lease_attempt, "runId": run_id,
                              "claimId": self.id});
        body[field] = json!(value);
        body
    }
}

/// The proxy asks to run `searches` of the job's searches, and reads the answer.
async fn claim(
    state: &crate::AppState,
    check: Check,
    searches: u32,
) -> anyhow::Result<(StatusCode, serde_json::Value)> {
    send(state, CLAIM, check.body("searches", searches)).await
}

/// The proxy says how many of the check's searches ran.
async fn settle(state: &crate::AppState, check: Check, ran: u32) -> anyhow::Result<StatusCode> {
    Ok(send(state, SETTLE, check.body("ran", ran)).await?.0)
}

/// What the proxy sends the controller, and what it reads back.
async fn send(
    state: &crate::AppState,
    path: &str,
    body: serde_json::Value,
) -> anyhow::Result<(StatusCode, serde_json::Value)> {
    let request = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(axum::http::header::AUTHORIZATION, "Bearer credential-lease")
        .body(axum::body::Body::from(body.to_string()))?;
    let response = crate::managed_web_search::router()
        .with_state(state.clone())
        .oneshot(request)
        .await?;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024).await?;
    let body = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes)?
    };
    Ok((status, body))
}

/// The fixture's job leased to the space's runtime, as the runtime that runs it holds it, and the
/// agent token of that runtime.
async fn lease_for_search(fixture: &ReservedManagedAiPrompt) -> anyhow::Result<String> {
    let token = crate::tests::lease_job_to_space_runtime(
        &fixture.pool,
        &fixture.config,
        &fixture.project_id,
        &fixture.job_id,
    )
    .await?;
    fixture
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs set lease_attempts = 1, lease_expires_at = now() + interval '10 minutes'
              where id = $1",
            &[&fixture.job_id],
        )
        .await?;
    Ok(token)
}

/// A second job of the fixture's message, as a team plan's worker is: bound to the first job's
/// task budget, on the same runtime and run, and leased.
async fn seed_worker(fixture: &ReservedManagedAiPrompt) -> anyhow::Result<uuid::Uuid> {
    let worker = uuid::Uuid::new_v4();
    let mut connection = fixture.pool.get().await?;
    let transaction = connection.transaction().await?;
    transaction
        .execute(
            "insert into agent_jobs (id, project_id, run_id, prompt_id, intent, status, payload,
                                     lease_attempts, lease_expires_at, leased_by_runtime_id,
                                     parent_job_id)
             select $1::uuid, project_id, run_id, prompt_id, 'feature', 'leased',
                    jsonb_build_object('metadata', jsonb_build_object(
                        'managedAiUsed', true,
                        'multiAgentPlan', jsonb_build_object('role', 'worker', 'parentJobId', id::text))),
                    1, now() + interval '10 minutes', leased_by_runtime_id, id
               from agent_jobs where id = $2::uuid",
            &[&worker, &fixture.job_id],
        )
        .await?;
    crate::research_budget::bind_job(
        &transaction,
        fixture.project_id,
        worker,
        Some(fixture.job_id),
    )
    .await
    .map_err(|(status, axum::Json(error))| {
        anyhow::anyhow!("bind the worker's budget: {status} {}", error.message)
    })?;
    transaction.commit().await?;
    Ok(worker)
}

const CLAIM: &str = "/internal/managed-web-search/claim";
const SETTLE: &str = "/internal/managed-web-search/settle";

/// A message runs at most 2 web searches in all, whichever of its jobs asks: the lead's turn
/// runs one, its team plan's worker one, and a third, from either, is refused, so it never runs
/// and is never charged. A search that did not run goes back to the message. Turning the
/// controller's switch off refuses the next search at once, whatever the jobs' grants say.
#[tokio::test]
async fn a_third_search_in_one_message_is_refused_across_its_jobs() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("web-search-claims").await? else {
        eprintln!("skipping web search claim test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let outcome = async {
        lease_for_search(&fixture).await?;
        let worker = seed_worker(&fixture).await?;
        let mut state = fixture.state.clone();
        state.config.managed_ai_native_web_search = true;
        let lead = (fixture.project_id, fixture.job_id, fixture.run_id);
        let worker = (fixture.project_id, worker, fixture.run_id);
        let before = credit_balance(&fixture.pool, &fixture.org_id).await?;

        assert_eq!(
            claim(&state, Check::of(lead), 1).await?,
            (StatusCode::OK, json!({"granted": 1, "limit": 2}))
        );
        let workers = Check::of(worker);
        assert_eq!(
            claim(&state, workers, 2).await?,
            (
                StatusCode::OK,
                json!({"granted": 1, "limit": 2, "refused": "used"})
            )
        );
        for job in [lead, worker] {
            assert_eq!(
                claim(&state, Check::of(job), 1).await?,
                (
                    StatusCode::OK,
                    json!({"granted": 0, "limit": 2, "refused": "used"})
                ),
                "a third search"
            );
        }
        // The worker's search failed: it goes back, and the message may run one more.
        assert_eq!(settle(&state, workers, 0).await?, StatusCode::NO_CONTENT);
        let leads = Check::of(lead);
        assert_eq!(claim(&state, leads, 1).await?.1["granted"], 1);
        // The proxy never read that answer (it timed out), so it settles the check with none:
        // its search goes back, and the same check landing again takes nothing more.
        assert_eq!(settle(&state, leads, 0).await?, StatusCode::NO_CONTENT);
        assert_eq!(claim(&state, leads, 1).await?.1["granted"], 0);
        // One it gave up on before it landed takes nothing when it lands.
        let landed_late = Check::of(worker);
        assert_eq!(
            settle(&state, landed_late, 0).await?,
            StatusCode::NO_CONTENT
        );
        assert_eq!(claim(&state, landed_late, 1).await?.1["granted"], 0);
        assert_eq!(claim(&state, Check::of(worker), 1).await?.1["granted"], 1);
        // A claim writes no credits: the searches that ran are charged with the turn.
        assert_eq!(
            credit_balance(&fixture.pool, &fixture.org_id).await?,
            before
        );
        let rows = web_search_rows(&fixture.pool, &fixture.project_id).await?;
        assert!(rows.is_empty(), "{rows:?}");

        // The switch, read on every search: off refuses the next one at once.
        state.config.managed_ai_native_web_search = false;
        assert_eq!(
            claim(&state, Check::of(lead), 1).await?,
            (
                StatusCode::OK,
                json!({"granted": 0, "limit": 2, "refused": "off"})
            )
        );
        // Only the proxy's own bearer may ask.
        let mut wrong = state.clone();
        wrong.config.proxy_credential_lease_token = Some("another".into());
        assert_eq!(
            claim(&wrong, Check::of(lead), 1).await?.0,
            StatusCode::UNAUTHORIZED
        );
        anyhow::Ok(())
    }
    .await;
    with_cleanup(fixture, async move { outcome }).await
}

/// A background check that may decline (an ambient evaluation) gets no search until it answers,
/// and then searches as any turn; a job that no longer holds its lease gets none. A message whose
/// routing step read the person's words as asking for deeper research runs up to 8, said by the
/// runtime that holds the job's lease.
#[tokio::test]
async fn an_ambient_check_searches_only_once_it_answers_and_deeper_research_runs_eight(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("web-search-ambient").await? else {
        eprintln!("skipping ambient web search claim test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let outcome = async {
        let agent_token = lease_for_search(&fixture).await?;
        let mut state = fixture.state.clone();
        state.config.managed_ai_native_web_search = true;
        let job = (fixture.project_id, fixture.job_id, fixture.run_id);
        let set_metadata = |metadata: serde_json::Value| {
            let pool = fixture.pool.clone();
            let job_id = fixture.job_id;
            async move {
                pool.get()
                    .await?
                    .execute(
                        "update agent_jobs
                            set payload = jsonb_set(payload, '{metadata}',
                                                    payload -> 'metadata' || $2::jsonb)
                          where id = $1",
                        &[&job_id, &tokio_postgres::types::Json(metadata)],
                    )
                    .await?;
                anyhow::Ok(())
            }
        };
        set_metadata(json!({"managedAiUsed": false, "managedAiBillingDeferred": true})).await?;
        assert_eq!(
            claim(&state, Check::of(job), 1).await?,
            (
                StatusCode::OK,
                json!({"granted": 0, "limit": 2, "refused": "undecided"})
            )
        );
        // It answered: its first reply marked it used, as its deferred charge does.
        set_metadata(json!({"managedAiUsed": true})).await?;
        assert_eq!(claim(&state, Check::of(job), 1).await?.1["granted"], 1);

        // Deeper research, from the runtime that holds the lease.
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/agent/jobs/{}/deeper-research", fixture.job_id))
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .header(
                axum::http::header::AUTHORIZATION,
                format!("Bearer {agent_token}"),
            )
            .body(axum::body::Body::from(
                json!({"lease_attempt": 1}).to_string(),
            ))?;
        let response = crate::managed_web_search::router()
            .with_state(state.clone())
            .oneshot(request)
            .await?;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            claim(&state, Check::of(job), 4).await?,
            (StatusCode::OK, json!({"granted": 4, "limit": 8}))
        );
        assert_eq!(
            claim(&state, Check::of(job), 4).await?,
            (
                StatusCode::OK,
                json!({"granted": 3, "limit": 8, "refused": "used"})
            )
        );

        // A job whose lease has ended searches nothing.
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set status = 'succeeded' where id = $1",
                &[&fixture.job_id],
            )
            .await?;
        assert_eq!(
            claim(&state, Check::of(job), 1).await?,
            (
                StatusCode::OK,
                json!({"granted": 0, "limit": 2, "refused": "ended"})
            )
        );
        anyhow::Ok(())
    }
    .await;
    with_cleanup(fixture, async move { outcome }).await
}

/// A turn put back in the queue (its machine stopped, its lease lapsed, or a short rate limit)
/// runs again as the job's next lease attempt, and no completion charged the attempt before it:
/// when the new attempt first asks, the earlier attempt's searches go back to the message, so it
/// may search again, within the message's limit. The earlier attempt can no longer search.
#[tokio::test]
async fn a_turn_put_back_in_the_queue_may_search_again_when_it_runs_again() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("web-search-requeue").await? else {
        eprintln!("skipping requeued web search test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let outcome = async {
        lease_for_search(&fixture).await?;
        let mut state = fixture.state.clone();
        state.config.managed_ai_native_web_search = true;
        let job = (fixture.project_id, fixture.job_id, fixture.run_id);
        assert_eq!(claim(&state, Check::of(job), 2).await?.1["granted"], 2);
        assert_eq!(claim(&state, Check::of(job), 1).await?.1["granted"], 0);

        // Its machine stopped: the job went back to the queue and was leased again.
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set lease_attempts = 2, lease_expires_at = now() + interval '10 minutes'
                  where id = $1",
                &[&fixture.job_id],
            )
            .await?;
        assert_eq!(
            claim(&state, Check::of(job), 1).await?,
            (
                StatusCode::OK,
                json!({"granted": 0, "limit": 2, "refused": "ended"})
            ),
            "the earlier attempt"
        );
        assert_eq!(
            claim(&state, Check::of_attempt(job, 2), 1).await?,
            (StatusCode::OK, json!({"granted": 1, "limit": 2}))
        );
        assert_eq!(
            claim(&state, Check::of_attempt(job, 2), 2).await?,
            (
                StatusCode::OK,
                json!({"granted": 1, "limit": 2, "refused": "used"})
            )
        );
        let rows = web_search_rows(&fixture.pool, &fixture.project_id).await?;
        assert!(rows.is_empty(), "{rows:?}");
        anyhow::Ok(())
    }
    .await;
    with_cleanup(fixture, async move { outcome }).await
}
