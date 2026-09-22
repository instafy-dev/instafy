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
        org_id,
        project_id,
        job_id,
        run_id,
        prompt_id,
        burn_amount,
        reserved_balance,
    }))
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

fn mint_agent_complete_token(config: &AppConfig, project_id: &Uuid) -> anyhow::Result<String> {
    let minted = mint_scoped_token(
        config,
        ScopedTokenRequest {
            audience: project_id.to_string(),
            subject: "agent:managed-ai-refund-test".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: None,
            scopes: vec!["agent.complete".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| controller_error("mint agent token", error))?;
    Ok(minted.token)
}

async fn post_agent_complete(
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
    let token = mint_agent_complete_token(&fixture.config, &fixture.project_id)?;
    let response = agent::router()
        .with_state(fixture.state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/complete")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    Ok(response.status())
}

const PROXY_401_ERROR: &str = "unexpected status 401 Unauthorized: proxy token missing credential_id for BYOC request, url: http://proxy:8789/v1/responses";

#[tokio::test]
async fn managed_ai_prompt_refunds_when_completion_fails_before_upstream() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("refund-on-401").await? else {
        eprintln!("skipping managed AI refund test: TEST_DATABASE_URL not set");
        return Ok(());
    };
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
    Ok(())
}

#[tokio::test]
async fn managed_ai_prompt_keeps_charge_when_failure_may_have_reached_upstream(
) -> anyhow::Result<()> {
    struct Case {
        label: &'static str,
        error_message: &'static str,
        artifacts: serde_json::Value,
        /// Usage reconciliation writes the ledger; a kept charge alone does not.
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
            credit_signals: 1,
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
        let mut credit_events = fixture.state.events.subscribe();

        let status = post_agent_complete(
            &fixture,
            json!({
                "job_id": fixture.job_id,
                "outcome": "failed",
                "error_message": case.error_message,
                "artifacts": case.artifacts,
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
        let (run_status, _) = run_row(&fixture.pool, &fixture.run_id).await?;
        assert_eq!(run_status, "failed", "{}", case.label);
    }
    Ok(())
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
