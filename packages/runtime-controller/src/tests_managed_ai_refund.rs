//! Managed-AI prompt refunds at the terminal run-failure sinks.
//!
//! The prompt reserve is burned at dispatch. A run that fails before any model
//! turn must give the credit and the daily prompt slot back exactly once.

use crate::auth::RequestContext;
use crate::config::{AppConfig, PgPool};
use crate::credits::ManagedAiRefundOutcome;
use crate::dispatch::{self, DispatchPromptRequest};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, setup_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::{agent, AppState};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::json;
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

pub(crate) struct ReservedManagedAiPrompt {
    pub(crate) pool: PgPool,
    pub(crate) config: AppConfig,
    pub(crate) state: AppState,
    pub(crate) owner_user_id: Uuid,
    pub(crate) other_user_id: Uuid,
    pub(crate) org_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) job_id: Uuid,
    pub(crate) run_id: Uuid,
    pub(crate) prompt_id: Uuid,
    /// Credits the reserve burn took (`managed_ai_credit_burn_amount`).
    pub(crate) burn_amount: i32,
    /// The org balance right after the reserve burn. The burn auto-refills
    /// the org to its credit limit first, so the number depends on that
    /// window rather than on the 20-credit seed; tests reason relative to it.
    pub(crate) reserved_balance: i32,
}

fn controller_error(
    context: &str,
    error: (StatusCode, axum::Json<crate::ApiError>),
) -> anyhow::Error {
    let (status, axum::Json(body)) = error;
    anyhow::anyhow!(
        "{context} failed with status {} and message {}",
        status.as_u16(),
        body.message
    )
}

/// Dispatch a managed-AI prompt and leave it in the state the normal managed
/// lane leaves at dispatch: one `managed_ai_prompt` reserve burned under
/// `managed-ai-prompt:{prompt_id}` and `managedAiUsed` set on the prompt, the
/// run and the job payload. The balance after the burn is captured on the
/// fixture as `reserved_balance`.
///
/// The test config has no proxy, so the normal lane cannot dispatch here; the
/// ambient lane creates the same prompt, run and job rows, and the reserve is
/// burned with the exact call dispatch uses.
pub(crate) async fn seed_reserved_managed_ai_prompt(
    label: &str,
) -> anyhow::Result<Option<ReservedManagedAiPrompt>> {
    let Some(pool) = setup_origin_test_pool().await? else {
        return Ok(None);
    };

    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&org_id, &format!("{label}-{org_id}"), &label],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder')",
                &[&org_id, &owner_user_id, &other_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, $3, $4, 'customer', 'active')",
                &[&project_id, &org_id, &label, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &other_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&org_id, &project_id],
            )
            .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        &format!("managed-ai-refund-{label}"),
    );
    let state = build_test_state(pool.clone(), config.clone());

    let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Should we keep the blue version?".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": ["octo"], "mentions": [] }
        })),
        conversation_metadata: Some(json!({ "visibility": "public" })),
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize managed AI dispatch", error))?;
    let response = dispatch::process_dispatch_prompt(
        &state,
        &RequestContext {
            user_id: Some(owner_user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        request,
    )
    .await
    .map_err(|error| controller_error("process managed AI dispatch", error))?;
    assert_eq!(response.status, "queued");

    let mut connection = pool.get().await?;
    let job_row = connection
        .query_one(
            "select id, run_id from agent_jobs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?;
    let job_id: Uuid = job_row.get("id");
    let run_id: Uuid = job_row
        .get::<_, Option<Uuid>>("run_id")
        .expect("a dispatched job has a run");
    let prompt_id: Uuid = connection
        .query_one(
            "select id from prompts where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get("id");

    // Mirror the normal managed lane's dispatch-time state.
    let transaction = connection.transaction().await?;
    let mut burn_metadata = json!({
        "source": "managed_ai",
        "promptId": prompt_id,
        "managedAiLabel": config.managed_ai_label,
    });
    crate::credits::process_credit_burn(
        &transaction,
        &project_id,
        &org_id,
        None,
        config.managed_ai_credit_burn_amount,
        "managed_ai_prompt",
        Some(&format!("managed-ai-prompt:{prompt_id}")),
        &mut burn_metadata,
    )
    .await
    .map_err(|error| controller_error("burn managed AI reserve", error))?;
    dispatch::persist_prompt_ai_access_metadata(&transaction, &prompt_id, true, true)
        .await
        .map_err(|error| controller_error("mark prompt managed AI used", error))?;
    dispatch::persist_run_ai_access_metadata(&transaction, &[run_id], true, true)
        .await
        .map_err(|error| controller_error("mark run managed AI used", error))?;
    transaction
        .execute(
            "update agent_jobs
             set payload = jsonb_set(
                     coalesce(payload, '{}'::jsonb),
                     '{metadata}',
                     (coalesce(payload -> 'metadata', '{}'::jsonb) - 'managedAiBillingDeferred')
                         || '{\"managedAiUsed\": true}'::jsonb,
                     true
                 )
             where id = $1",
            &[&job_id],
        )
        .await?;
    transaction.commit().await?;
    drop(connection);

    let burn_amount = config.managed_ai_credit_burn_amount;
    let reserved_balance = credit_balance(&pool, &org_id).await?;
    let reserve_key = format!("managed-ai-prompt:{prompt_id}");
    let rows = ledger_rows(&pool, &project_id).await?;
    assert!(
        rows.iter()
            .any(|(reason, delta, key)| reason == "managed_ai_prompt"
                && *delta == -burn_amount
                && key.as_deref() == Some(reserve_key.as_str())),
        "the reserve is burned under its key, got {rows:?}"
    );
    assert_eq!(
        prompt_metadata(&pool, &prompt_id).await?["managedAiUsed"],
        json!(true)
    );
    assert_eq!(daily_prompts_used(&pool, &owner_user_id).await?, 1);

    Ok(Some(ReservedManagedAiPrompt {
        pool,
        config,
        state,
        owner_user_id,
        other_user_id,
        org_id,
        project_id,
        job_id,
        run_id,
        prompt_id,
        burn_amount,
        reserved_balance,
    }))
}

impl ReservedManagedAiPrompt {
    /// Deletes the org, which cascades to its project and everything the
    /// fixture created under it, then both users.
    pub(crate) async fn cleanup(&self) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        connection
            .execute("delete from organizations where id = $1", &[&self.org_id])
            .await?;
        connection
            .execute(
                "delete from auth.users where id = any($1)",
                &[&vec![self.owner_user_id, self.other_user_id]],
            )
            .await?;
        Ok(())
    }
}

pub(crate) async fn credit_balance(pool: &PgPool, org_id: &Uuid) -> anyhow::Result<i32> {
    let connection = pool.get().await?;
    Ok(connection
        .query_one(
            "select balance from org_credit_balances where org_id = $1",
            &[org_id],
        )
        .await?
        .get("balance"))
}

/// Ledger rows for the project as (reason, delta, idempotency_key), oldest first.
pub(crate) async fn ledger_rows(
    pool: &PgPool,
    project_id: &Uuid,
) -> anyhow::Result<Vec<(String, i32, Option<String>)>> {
    let connection = pool.get().await?;
    let rows = connection
        .query(
            "select reason, delta, idempotency_key from org_credit_ledger
             where project_id = $1 order by created_at, reason",
            &[project_id],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get("reason"),
                row.get("delta"),
                row.get("idempotency_key"),
            )
        })
        .collect())
}

pub(crate) async fn ledger_metadata_by_key(
    pool: &PgPool,
    project_id: &Uuid,
    idempotency_key: &str,
) -> anyhow::Result<serde_json::Value> {
    let connection = pool.get().await?;
    let row = connection
        .query_one(
            "select metadata from org_credit_ledger where project_id = $1 and idempotency_key = $2",
            &[project_id, &idempotency_key],
        )
        .await?;
    Ok(row
        .get::<_, Option<PgJson<serde_json::Value>>>("metadata")
        .map(|value| value.0)
        .unwrap_or(serde_json::Value::Null))
}

pub(crate) async fn prompt_metadata(
    pool: &PgPool,
    prompt_id: &Uuid,
) -> anyhow::Result<serde_json::Value> {
    let connection = pool.get().await?;
    let row = connection
        .query_one("select metadata from prompts where id = $1", &[prompt_id])
        .await?;
    Ok(row
        .get::<_, Option<PgJson<serde_json::Value>>>("metadata")
        .map(|value| value.0)
        .unwrap_or(serde_json::Value::Null))
}

pub(crate) async fn run_row(
    pool: &PgPool,
    run_id: &Uuid,
) -> anyhow::Result<(String, serde_json::Value)> {
    let connection = pool.get().await?;
    let row = connection
        .query_one("select status, metadata from runs where id = $1", &[run_id])
        .await?;
    Ok((
        row.get("status"),
        row.get::<_, Option<PgJson<serde_json::Value>>>("metadata")
            .map(|value| value.0)
            .unwrap_or(serde_json::Value::Null),
    ))
}

/// What GET /me/credentials/requirements reports as dailyPromptsUsed.
pub(crate) async fn daily_prompts_used(pool: &PgPool, user_id: &Uuid) -> anyhow::Result<i32> {
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let count = crate::credentials::count_recent_managed_ai_prompts(
        &transaction,
        Some(*user_id),
        Utc::now() - ChronoDuration::hours(24),
    )
    .await
    .map_err(|error| controller_error("count managed AI prompts", error))?;
    transaction.commit().await?;
    Ok(count)
}

fn mint_agent_token(config: &AppConfig, project_id: &Uuid, scope: &str) -> anyhow::Result<String> {
    let minted = mint_scoped_token(
        config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: "agent:managed-ai-refund-test".to_string(),
            project_id: project_id.to_string(),
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
    .map_err(|error| controller_error("mint agent token", error))?;
    Ok(minted.token)
}

/// Leases the fixture's job and builds its `/agent/complete` request.
pub(crate) async fn agent_complete_request(
    fixture: &ReservedManagedAiPrompt,
    body: serde_json::Value,
) -> anyhow::Result<Request<Body>> {
    {
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update agent_jobs set status = 'leased' where id = $1",
                &[&fixture.job_id],
            )
            .await?;
    }
    let token = mint_agent_token(&fixture.config, &fixture.project_id, "agent.complete")?;
    Ok(Request::builder()
        .method("POST")
        .uri("/agent/complete")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))?)
}

/// Posts one of the leased job's progress messages, as the runtime streams
/// them, through `/agent/message`.
pub(crate) async fn post_agent_message(
    fixture: &ReservedManagedAiPrompt,
    body: serde_json::Value,
) -> anyhow::Result<StatusCode> {
    {
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update agent_jobs set status = 'leased' where id = $1",
                &[&fixture.job_id],
            )
            .await?;
    }
    let token = mint_agent_token(&fixture.config, &fixture.project_id, "agent.message")?;
    let request = Request::builder()
        .method("POST")
        .uri("/agent/message")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))?;
    let response = agent::router()
        .with_state(fixture.state.clone())
        .oneshot(request)
        .await?;
    Ok(response.status())
}

async fn post_agent_complete(
    fixture: &ReservedManagedAiPrompt,
    body: serde_json::Value,
) -> anyhow::Result<StatusCode> {
    let request = agent_complete_request(fixture, body).await?;
    let response = agent::router()
        .with_state(fixture.state.clone())
        .oneshot(request)
        .await?;
    Ok(response.status())
}

const PROXY_401_ERROR: &str = "unexpected status 401 Unauthorized: proxy token missing credential_id for BYOC request, url: http://proxy:8789/v1/responses";

/// An artifact saying the turn wrote a file. A failed turn that left the
/// person nothing costs nothing whatever ended it (crate::system_turns), so a
/// test of what a refusal refunds gives its turn something it left: then only
/// the refusal rule can give the reserve back.
fn wrote_a_file() -> serde_json::Value {
    json!({ "kind": "apply/files", "files": [{ "path": "notes.md", "changeType": "changed" }] })
}

#[tokio::test]
async fn managed_ai_prompt_refunds_when_completion_fails_before_upstream() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("refund-on-401").await? else {
        eprintln!("skipping managed AI refund test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let _watch = fixture.state.events.watch_project(fixture.project_id);
    let mut credit_events = fixture.state.events.subscribe();

    let status = post_agent_complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "failed",
            "error_message": PROXY_401_ERROR,
            "artifacts": [],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        crate::tests::queued_credit_signals(&mut credit_events, fixture.project_id),
        1,
        "the committed refund is signalled"
    );

    let refund_key = format!("managed-ai-refund:{}", fixture.prompt_id);
    let reserve_key = format!("managed-ai-prompt:{}", fixture.prompt_id);
    let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
    // The seed and the burn's daily auto-refill sit alongside; only the
    // managed-AI rows are the contract here.
    let managed_ai_rows: Vec<_> = rows
        .iter()
        .filter(|(reason, _, _)| reason == "managed_ai_prompt" || reason == "managed_ai_refund")
        .cloned()
        .collect();
    assert_eq!(
        managed_ai_rows,
        vec![
            (
                "managed_ai_prompt".to_string(),
                -fixture.burn_amount,
                Some(reserve_key.clone())
            ),
            (
                "managed_ai_refund".to_string(),
                fixture.burn_amount,
                Some(refund_key.clone())
            ),
        ],
        "the reserve is given back as one refund row, got {rows:?}"
    );
    assert_eq!(
        credit_balance(&fixture.pool, &fixture.org_id).await?,
        fixture.reserved_balance + fixture.burn_amount
    );

    let reserve_metadata =
        ledger_metadata_by_key(&fixture.pool, &fixture.project_id, &reserve_key).await?;
    assert_eq!(reserve_metadata["refunded"], json!(true));
    assert_eq!(
        reserve_metadata["refundReason"],
        json!("proxy_auth_rejected")
    );
    let refund_metadata =
        ledger_metadata_by_key(&fixture.pool, &fixture.project_id, &refund_key).await?;
    assert_eq!(refund_metadata["source"], json!("managed_ai_refund"));
    assert_eq!(refund_metadata["promptId"], json!(fixture.prompt_id));

    let prompt = prompt_metadata(&fixture.pool, &fixture.prompt_id).await?;
    assert_eq!(prompt["aiAccessMode"], json!("managed"));
    assert_eq!(
        prompt["managedAiUsed"],
        json!(false),
        "the daily prompt slot must be released"
    );
    assert_eq!(
        daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
        0
    );

    let (run_status, run_metadata) = run_row(&fixture.pool, &fixture.run_id).await?;
    assert_eq!(run_status, "failed");
    assert_eq!(run_metadata["managedAiUsed"], json!(false));
    assert_eq!(
        run_metadata["managedAiCredit"]["refund"]["idempotencyKey"],
        json!(refund_key)
    );
    assert_eq!(
        run_metadata["managedAiCredit"]["refund"]["refundReason"],
        json!("proxy_auth_rejected")
    );
    assert_eq!(
        run_metadata["managedAiCredit"]["refund"]["delta"],
        json!(fixture.burn_amount)
    );
    fixture.cleanup().await
}

/// What Codex stores when the proxy cannot renew the managed sign-in: its 424
/// and the envelope's fixed sentence, without the JSON code.
const PROXY_REFRESH_FAILED_ERROR: &str = "unexpected status 424 Failed Dependency: Upstream credentials could not be refreshed., url: http://proxy:8789/v1/responses";

/// The provider's 400 as the proxy passes it on: refused as sent.
const PROVIDER_400_ERROR: &str = "unexpected status 400 Bad Request: The upstream provider rejected the request., url: http://proxy:8789/v1/responses";

/// The proxy's 424 for a sign-in it could not renew, and a request the AI
/// refused as sent, are decided before any model call, so the reserve and the
/// daily slot come back, once: the same completion delivered again writes no
/// second refund. A usage receipt that shows an answered call keeps the
/// charge, and so does one whose failed call had a response complete first.
#[tokio::test]
async fn managed_ai_prompt_refunds_a_sign_in_the_proxy_could_not_renew() -> anyhow::Result<()> {
    let answered_call = crate::task_usage::tests::receipt_fixture();
    let mut answered_then_failed = crate::task_usage::tests::receipt_fixture();
    answered_then_failed["calls"][0]["outcome"] = json!("error");
    answered_then_failed["calls"][0]["usageStatus"] = json!("partial");
    for (label, error_message, artifacts, refund_reason) in [
        (
            "refund-on-424",
            PROXY_REFRESH_FAILED_ERROR,
            json!([]),
            Some("proxy_auth_rejected"),
        ),
        (
            "refund-on-400",
            PROVIDER_400_ERROR,
            json!([]),
            Some("request_rejected"),
        ),
        (
            "keep-after-an-answered-call",
            PROXY_REFRESH_FAILED_ERROR,
            json!([answered_call]),
            None,
        ),
        (
            "keep-after-an-answer-in-a-failed-call",
            PROXY_REFRESH_FAILED_ERROR,
            json!([answered_then_failed]),
            None,
        ),
    ] {
        let Some(fixture) = seed_reserved_managed_ai_prompt(label).await? else {
            eprintln!("skipping managed AI 424 refund test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let mut artifacts = artifacts;
        artifacts.as_array_mut().unwrap().push(wrote_a_file());
        let completion = json!({
            "job_id": fixture.job_id,
            "outcome": "failed",
            "error_message": error_message,
            "artifacts": artifacts,
        });
        for delivery in 1..=2 {
            let status = post_agent_complete(&fixture, completion.clone()).await?;
            assert_eq!(status, StatusCode::OK, "{label}: delivery {delivery}");

            let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
            let refunds: Vec<_> = rows
                .iter()
                .filter(|(reason, _, _)| reason == "managed_ai_refund")
                .collect();
            let prompt = prompt_metadata(&fixture.pool, &fixture.prompt_id).await?;
            if let Some(refund_reason) = refund_reason {
                assert_eq!(
                    refunds,
                    vec![&(
                        "managed_ai_refund".to_string(),
                        fixture.burn_amount,
                        Some(format!("managed-ai-refund:{}", fixture.prompt_id))
                    )],
                    "{label}: delivery {delivery} got {rows:?}"
                );
                assert_eq!(
                    credit_balance(&fixture.pool, &fixture.org_id).await?,
                    fixture.reserved_balance + fixture.burn_amount,
                    "{label}: delivery {delivery}"
                );
                let reserve_metadata = ledger_metadata_by_key(
                    &fixture.pool,
                    &fixture.project_id,
                    &format!("managed-ai-prompt:{}", fixture.prompt_id),
                )
                .await?;
                assert_eq!(
                    reserve_metadata["refundReason"],
                    json!(refund_reason),
                    "{label}"
                );
                assert_eq!(prompt["managedAiUsed"], json!(false), "{label}");
                assert_eq!(
                    daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
                    0,
                    "{label}: the daily prompt slot is released"
                );
            } else {
                assert!(refunds.is_empty(), "{label}: got {rows:?}");
                assert_eq!(
                    credit_balance(&fixture.pool, &fixture.org_id).await?,
                    fixture.reserved_balance,
                    "{label}"
                );
                assert_eq!(prompt["managedAiUsed"], json!(true), "{label}");
            }
        }
        fixture.cleanup().await?;
    }
    Ok(())
}

/// A command execution as the runtime streams it. The routing
/// pre-observation is one the runtime runs itself before Codex's first model
/// call, and says so in its `source`.
fn command_execution_message(
    job_id: Uuid,
    item_id: &str,
    source: Option<&str>,
) -> serde_json::Value {
    let mut metadata = json!({
        "kind": "codex_command_execution",
        "status": "completed",
        "command": "git status --short",
        "exitCode": 0,
        "timedOut": false,
        "aggregatedOutput": "",
        "eventType": "item.completed",
        "itemId": item_id,
        "runtimeId": Uuid::new_v4(),
    });
    if let Some(source) = source {
        metadata["source"] = json!(source);
    }
    json!({
        "job_id": job_id,
        "content": "git status --short",
        "message_type": "command_execution",
        "metadata": metadata,
    })
}

/// The runtime streams its routing pre-observation before Codex runs, so a
/// turn whose first model call the proxy rejects already shows a command
/// execution. That is not the model working: the reserve and the daily slot
/// still come back. A command Codex ran keeps them.
#[tokio::test]
async fn managed_ai_prompt_refunds_a_failed_turn_that_only_showed_its_routing_pre_observation(
) -> anyhow::Result<()> {
    for (label, codex_ran_a_command, refunded) in [
        ("refund-after-pre-observation", false, true),
        ("keep-after-codex-command", true, false),
    ] {
        let Some(fixture) = seed_reserved_managed_ai_prompt(label).await? else {
            eprintln!("skipping managed AI pre-observation refund test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let pre_observation = command_execution_message(
            fixture.job_id,
            &format!("routing-pre-observation:{}", Uuid::new_v4()),
            Some("routing_pre_observation"),
        );
        assert_eq!(
            post_agent_message(&fixture, pre_observation).await?,
            StatusCode::OK
        );
        if codex_ran_a_command {
            let command = command_execution_message(fixture.job_id, "item_3", None);
            assert_eq!(post_agent_message(&fixture, command).await?, StatusCode::OK);
        }

        let status = post_agent_complete(
            &fixture,
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": PROXY_401_ERROR,
                "artifacts": [],
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{label}");

        let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
        let refunds = rows
            .iter()
            .filter(|(reason, _, _)| reason == "managed_ai_refund")
            .count();
        assert_eq!(refunds, usize::from(refunded), "{label}: got {rows:?}");
        let prompt = prompt_metadata(&fixture.pool, &fixture.prompt_id).await?;
        if refunded {
            assert_eq!(
                credit_balance(&fixture.pool, &fixture.org_id).await?,
                fixture.reserved_balance + fixture.burn_amount,
                "{label}"
            );
            assert_eq!(prompt["managedAiUsed"], json!(false), "{label}");
            assert_eq!(
                daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
                0,
                "{label}: the daily prompt slot is released"
            );
        } else {
            assert_eq!(
                credit_balance(&fixture.pool, &fixture.org_id).await?,
                fixture.reserved_balance,
                "{label}"
            );
            assert_eq!(prompt["managedAiUsed"], json!(true), "{label}");
        }
        fixture.cleanup().await?;
    }
    Ok(())
}

const PROVIDER_USAGE_LIMIT_ERROR: &str =
    "You\u{2019}ve hit your usage limit. Try again at Oct 23rd, 2026 8:40 AM.";

/// A turn the provider refused for a spent usage window never reached a
/// model: it gets its reserve back, unless its usage receipt shows a call
/// that did not fail. A plain throttle keeps the reserve.
#[tokio::test]
async fn managed_ai_prompt_refunds_when_the_provider_refused_a_spent_limit() -> anyhow::Result<()> {
    let failed_call = || {
        let mut receipt = crate::task_usage::tests::receipt_fixture();
        let call = &mut receipt["calls"][0];
        call["phase"] = json!("routing");
        call["outcome"] = json!("error");
        call["usageStatus"] = json!("unknown");
        call.as_object_mut().unwrap().remove("usage");
        receipt
    };
    let mut answered_then_limited = crate::task_usage::tests::receipt_fixture();
    let mut limited = failed_call()["calls"][0].clone();
    limited["invocationId"] = json!("5f0c8a52-3f4e-4b8e-9a51-0f6f2ad1c0e1");
    limited["phase"] = json!("main");
    answered_then_limited["calls"]
        .as_array_mut()
        .unwrap()
        .push(limited);

    struct Case {
        label: &'static str,
        error_message: &'static str,
        receipt: serde_json::Value,
        refunded: bool,
    }
    for case in [
        Case {
            label: "spent-usage-limit",
            error_message: PROVIDER_USAGE_LIMIT_ERROR,
            receipt: failed_call(),
            refunded: true,
        },
        Case {
            label: "usage-limit-after-an-answer",
            error_message: PROVIDER_USAGE_LIMIT_ERROR,
            receipt: answered_then_limited.clone(),
            refunded: false,
        },
        Case {
            label: "throttled",
            error_message: "exceeded retry limit, last status: 429 Too Many Requests",
            receipt: failed_call(),
            refunded: false,
        },
    ] {
        let Some(fixture) = seed_reserved_managed_ai_prompt(case.label).await? else {
            eprintln!("skipping managed AI usage-limit refund test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        // As the managed lane's dispatch leaves it.
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs
                 set payload = jsonb_set(payload, '{metadata,aiAccessMode}', '\"managed\"'::jsonb)
                 where id = $1",
                &[&fixture.job_id],
            )
            .await?;

        let status = post_agent_complete(
            &fixture,
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": case.error_message,
                "artifacts": [case.receipt, wrote_a_file()],
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{}", case.label);

        let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
        let refunds = rows
            .iter()
            .filter(|(reason, _, _)| reason == "managed_ai_refund")
            .count();
        assert_eq!(
            refunds,
            usize::from(case.refunded),
            "{}: got {rows:?}",
            case.label
        );
        let reserve_metadata = ledger_metadata_by_key(
            &fixture.pool,
            &fixture.project_id,
            &format!("managed-ai-prompt:{}", fixture.prompt_id),
        )
        .await?;
        let prompt = prompt_metadata(&fixture.pool, &fixture.prompt_id).await?;
        let (_, run_metadata) = run_row(&fixture.pool, &fixture.run_id).await?;
        if case.refunded {
            assert_eq!(
                credit_balance(&fixture.pool, &fixture.org_id).await?,
                fixture.reserved_balance + fixture.burn_amount
            );
            assert_eq!(
                reserve_metadata["refundReason"],
                json!("provider_limit_rejected")
            );
            assert_eq!(
                run_metadata["managedAiCredit"]["refund"]["refundReason"],
                json!("provider_limit_rejected")
            );
            assert_eq!(prompt["managedAiUsed"], json!(false));
            assert_eq!(
                daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
                0
            );
        } else {
            assert_eq!(
                reserve_metadata["refunded"],
                serde_json::Value::Null,
                "{}",
                case.label
            );
            assert_eq!(prompt["managedAiUsed"], json!(true), "{}", case.label);
        }

        // The final message says whose AI hit the limit, for the Studio.
        let message: PgJson<serde_json::Value> = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select metadata from conversation_messages
                 where metadata->>'jobId' = $1 and metadata->>'source' = 'agent'
                 order by created_at desc limit 1",
                &[&fixture.job_id.to_string()],
            )
            .await?
            .get(0);
        assert_eq!(
            message.0["aiAccessMode"],
            json!("managed"),
            "{}",
            case.label
        );
        fixture.cleanup().await?;
    }
    Ok(())
}

#[tokio::test]
async fn managed_ai_prompt_keeps_charge_when_failure_may_have_reached_upstream(
) -> anyhow::Result<()> {
    struct Case {
        label: &'static str,
        error_message: &'static str,
        artifacts: serde_json::Value,
        /// Only a ledger row signals: neither a kept charge nor a
        /// reconciliation whose usage matches the reserve writes one.
        credit_signals: usize,
    }
    let cases = [
        Case {
            // The run log carries a completed turn: tokens were consumed, so
            // usage reconciliation owns the settlement, not a refund.
            label: "usage-reported",
            error_message: PROXY_401_ERROR,
            artifacts: json!([
                {
                    "kind": "codex/run-log",
                    "events": [
                        {
                            "type": "turn.completed",
                            "usage": {
                                "input_tokens": 1200,
                                "cached_input_tokens": 0,
                                "output_tokens": 300
                            }
                        }
                    ]
                }
            ]),
            // 1,500 tokens cost exactly the one-credit reserve: the zero
            // adjustment only merges metadata into the reserve row.
            credit_signals: 0,
        },
        Case {
            // A completed turn that reported no usage (the runtime leaves
            // `usage` out and keeps only the thread total) still shows the
            // model was called, so a later proxy rejection is no refund.
            label: "turn-completed-without-usage",
            error_message: PROXY_401_ERROR,
            artifacts: json!([
                {
                    "kind": "codex/run-log",
                    "events": [
                        {
                            "type": "turn.completed",
                            "threadTotalUsage": {
                                "input_tokens": 150000,
                                "cached_input_tokens": 135000,
                                "output_tokens": 3000
                            }
                        }
                    ]
                }
            ]),
            credit_signals: 0,
        },
        Case {
            // An upstream error is not proof the model was never called.
            label: "upstream-error",
            error_message: "unexpected status 500 Internal Server Error",
            artifacts: json!([]),
            credit_signals: 0,
        },
    ];

    for case in cases {
        let Some(fixture) = seed_reserved_managed_ai_prompt(case.label).await? else {
            eprintln!("skipping managed AI keep-charge test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let _watch = fixture.state.events.watch_project(fixture.project_id);
        let mut credit_events = fixture.state.events.subscribe();

        let mut receipt = crate::task_usage::tests::receipt_fixture();
        receipt["calls"][0]["outcome"] = json!("error");
        if case.artifacts.pointer("/0/events/0/usage").is_some() {
            receipt["calls"][0]["usageStatus"] = json!("partial");
        } else {
            receipt["calls"][0]["usageStatus"] = json!("unknown");
            receipt["calls"][0].as_object_mut().unwrap().remove("usage");
        }
        let mut artifacts = case.artifacts;
        artifacts.as_array_mut().unwrap().push(receipt.clone());
        artifacts.as_array_mut().unwrap().push(wrote_a_file());

        let status = post_agent_complete(
            &fixture,
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": case.error_message,
                "artifacts": artifacts,
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{}", case.label);
        assert_eq!(
            crate::tests::queued_credit_signals(&mut credit_events, fixture.project_id),
            case.credit_signals,
            "{}",
            case.label
        );

        let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
        assert!(
            rows.iter()
                .all(|(reason, _, _)| reason != "managed_ai_refund"),
            "{}: no refund row expected, got {rows:?}",
            case.label
        );
        assert_eq!(
            credit_balance(&fixture.pool, &fixture.org_id).await?,
            fixture.reserved_balance,
            "{}: the reserve stays charged",
            case.label
        );
        let reserve_metadata = ledger_metadata_by_key(
            &fixture.pool,
            &fixture.project_id,
            &format!("managed-ai-prompt:{}", fixture.prompt_id),
        )
        .await?;
        assert_eq!(
            reserve_metadata["refunded"],
            serde_json::Value::Null,
            "{}",
            case.label
        );
        let prompt = prompt_metadata(&fixture.pool, &fixture.prompt_id).await?;
        assert_eq!(
            prompt["managedAiUsed"],
            json!(true),
            "{}: the daily prompt slot stays consumed",
            case.label
        );
        assert_eq!(
            daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
            1,
            "{}",
            case.label
        );
        let (run_status, metadata) = run_row(&fixture.pool, &fixture.run_id).await?;
        assert_eq!(run_status, "failed", "{}", case.label);
        assert_eq!(metadata["aiTaskUsage"][fixture.job_id.to_string()], receipt);
        fixture.cleanup().await?;
    }
    Ok(())
}

/// A completion whose usage exceeds the reserve writes an adjustment row and
/// signals credits.updated only once that row has committed, after the
/// completion's own events.
#[tokio::test]
async fn managed_ai_usage_adjustment_signals_credits_after_the_completion_commits(
) -> anyhow::Result<()> {
    use crate::tests::controller_event_fanout_tests::{send_probed, PublishProbe};

    let Some(fixture) = seed_reserved_managed_ai_prompt("adjustment-signal").await? else {
        eprintln!("skipping managed AI adjustment signal test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let _watch = fixture.state.events.watch_project(fixture.project_id);
    // 3,000 output tokens cost two credits against the one-credit reserve.
    let request = agent_complete_request(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "failed",
            "error_message": PROXY_401_ERROR,
            "artifacts": [
                {
                    "kind": "codex/run-log",
                    "events": [
                        {
                            "type": "turn.completed",
                            "usage": {
                                "input_tokens": 0,
                                "cached_input_tokens": 0,
                                "output_tokens": 3000
                            }
                        }
                    ]
                },
                wrote_a_file()
            ],
        }),
    )
    .await?;
    let (response, adjustments_at_publish) = send_probed(
        &agent::router().with_state(fixture.state.clone()),
        request,
        PublishProbe {
            events: fixture.state.events.subscribe(),
            kind: crate::credits::CREDITS_UPDATED_EVENT,
            project_id: Some(fixture.project_id),
            count_sql: "select count(*) from org_credit_ledger
                        where project_id = $1
                          and idempotency_key = 'managed-ai-adjustment:' || $2::uuid::text",
            params: vec![fixture.project_id, fixture.prompt_id],
        },
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        adjustments_at_publish, 1,
        "published before the adjustment committed"
    );
    assert_eq!(
        credit_balance(&fixture.pool, &fixture.org_id).await?,
        fixture.reserved_balance - 1
    );
    fixture.cleanup().await
}

#[tokio::test]
async fn managed_ai_refund_is_idempotent_across_sinks() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("refund-twice").await? else {
        eprintln!("skipping managed AI refund idempotency test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let status = post_agent_complete(
        &fixture,
        json!({
            "job_id": fixture.job_id,
            "outcome": "failed",
            "error_message": PROXY_401_ERROR,
            "artifacts": [],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let restored_balance = fixture.reserved_balance + fixture.burn_amount;
    assert_eq!(
        credit_balance(&fixture.pool, &fixture.org_id).await?,
        restored_balance
    );

    // The expiry sweep reaching the same prompt later must not pay again,
    // and must be told the refund already happened so it skips its own
    // side effects.
    {
        let mut connection = fixture.pool.get().await?;
        let transaction = connection.transaction().await?;
        let second = crate::credits::refund_unused_managed_ai_prompt(
            &transaction,
            &fixture.project_id,
            &fixture.org_id,
            None,
            &fixture.prompt_id,
            "runtime_not_ready",
        )
        .await
        .map_err(|error| controller_error("second refund", error))?;
        assert!(
            matches!(second, ManagedAiRefundOutcome::AlreadyRefunded(_)),
            "expected the existing refund row, got {second:?}"
        );
        transaction.commit().await?;
    }
    assert_eq!(
        credit_balance(&fixture.pool, &fixture.org_id).await?,
        restored_balance
    );
    let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
    assert_eq!(
        rows.iter()
            .filter(|(reason, _, _)| reason == "managed_ai_refund")
            .count(),
        1
    );
    Ok(())
}
