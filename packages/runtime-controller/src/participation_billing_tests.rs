use super::*;

#[tokio::test]
async fn ambient_runtime_failure_stays_out_of_chat_while_direct_and_automation_remain_actionable(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("ambient runtime failure visibility").await?;
    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;
    let result = with_shared_db_fixture(
        SharedDbFixture {
            organizations: vec![org_id],
            projects: vec![project_id],
        },
        async {
            seed_group_participation_project(
                &pool,
                &org_id,
                &project_id,
                &owner_user_id,
                &other_user_id,
                "ambient-runtime-failure",
            )
            .await?;
            pool.get().await?.execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&org_id, &project_id],
            ).await?;
            // The configured provider deliberately has no endpoint. Dispatch
            // must preserve this real, terminal startup failure diagnostically
            // without requiring a provider process or model call.
            let config = build_app_config(
                test_origin_private_key(),
                test_origin_public_key(),
                "ambient-runtime-failure",
            );
            assert!(config.runtime_providers.iter().all(|provider| provider.endpoint.is_none()));
            let state = build_test_state(pool.clone(), config);

            for mode in ["ambient", "direct", "automation"] {
                let conversation_id = Uuid::new_v4();
                let mut request = ambient_group_dispatch_request(&project_id, &conversation_id)?;
                if mode == "direct" {
                    // Direct and automation dispatch require usable AI access
                    // before queuing. Use the established inert BYOC fixture;
                    // the preceding ambient case stays managed and deferred.
                    // No runtime or provider is started to consume this key.
                    pool.get().await?.execute(
                        "insert into user_credentials (
                             id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                         ) values ($1, $2, 'openai_api_key', 'Runtime notice regression',
                             'test-nonce', 'test-ciphertext', '{}'::jsonb, true)",
                        &[&Uuid::new_v4(), &owner_user_id],
                    ).await?;
                    request.prompt_text = "@octo, report the workspace status.".to_string();
                    request.metadata["agentSelection"]["mentions"] = json!(["octo"]);
                } else if mode == "automation" {
                    let connection = pool.get().await?;
                    connection.execute(
                        "insert into conversations (id, project_id, created_by, metadata, visibility, thread_kind)
                         values ($1, $2, $3, '{}'::jsonb, 'private', 'automation')",
                        &[&conversation_id, &project_id, &owner_user_id],
                    ).await?;
                    connection.execute(
                        "insert into conversation_participants (conversation_id, user_id, role, added_by)
                         values ($1, $2, 'owner', $2)",
                        &[&conversation_id, &owner_user_id],
                    ).await?;
                    request.thread_kind = Some("automation".to_string());
                    request.conversation_metadata = Some(json!({"visibility":"private"}));
                    request.allow_silent_automation_decline = true;
                }
                let mut events = state.events.subscribe();
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
                .map_err(|error| controller_error(&format!("dispatch unavailable runtime ({mode})"), error))?;
                let run_id = response.run_id.expect("queued run");
                let connection = pool.get().await?;
                let metadata = connection.query_one(
                    "select metadata from runs where id = $1", &[&run_id],
                ).await?.get::<_, PgJson<serde_json::Value>>("metadata").0;
                assert_eq!(
                    crate::group_participation::metadata_marks_skill_mode_ambient_evaluation(&metadata),
                    mode == "ambient",
                );
                assert_eq!(metadata["aiAccessMode"], if mode == "ambient" { "managed" } else { "byoc" }, "{mode}");
                assert_eq!(metadata["runtimeAlert"]["reconnect"]["status"], "failed", "{mode}: {metadata}");
                assert!(metadata["runtimeAlert"]["message"].as_str().unwrap().contains("Open Machines"));
                let assistant_rows = connection.query(
                    "select content, metadata from conversation_messages
                     where conversation_id = $1 and role = 'assistant'", &[&conversation_id],
                ).await?;
                assert_eq!(assistant_rows.len(), usize::from(mode != "ambient"), "{mode}");
                if let Some(row) = assistant_rows.first() {
                    assert!(row.get::<_, String>("content").contains("Open Machines"));
                    assert_eq!(row.get::<_, PgJson<serde_json::Value>>("metadata").0["kind"], "runtime_alert");
                }
                let mut runtime_event_seen = false;
                let mut assistant_events = 0;
                while let Ok(event) = events.try_recv() {
                    if event.run_id != Some(run_id) {
                        continue;
                    }
                    runtime_event_seen |= event.kind == "runtime.unavailable";
                    if event.kind == "conversation.message_created" && event.data["role"] == "assistant" {
                        assistant_events += 1;
                        assert_eq!(event.data["metadata"]["kind"], "runtime_alert");
                    }
                }
                assert!(runtime_event_seen, "{mode}: operational runtime event must survive");
                assert_eq!(assistant_events, usize::from(mode != "ambient"), "{mode}");
            }
            Ok(())
        },
    )
    .await;
    let owner_cleanup = cleanup_test_user(&pool, &owner_user_id).await;
    let other_cleanup = cleanup_test_user(&pool, &other_user_id).await;
    result?;
    owner_cleanup?;
    other_cleanup?;
    Ok(())
}

async fn assert_ambient_telemetry_billing(
    variant: &str,
    streamed_messages: &[&str],
    completion_answer: Option<&str>,
    should_bill: bool,
) -> anyhow::Result<()> {
    assert_ambient_telemetry_for_access_mode(
        variant,
        streamed_messages,
        completion_answer,
        should_bill,
        true,
        false,
    )
    .await
}

async fn assert_ambient_telemetry_for_access_mode(
    variant: &str,
    streamed_messages: &[&str],
    completion_answer: Option<&str>,
    expects_answer: bool,
    managed_access: bool,
    automation: bool,
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("participation billing regression").await?;
    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let should_bill = expects_answer && managed_access;
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;
    if !managed_access {
        pool.get()
            .await?
            .execute(
                "insert into user_credentials (
                id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
             ) values ($1, $2, 'openai_api_key', 'Ambient BYOC regression',
                'test-nonce', 'test-ciphertext', '{}'::jsonb, true)",
                &[&Uuid::new_v4(), &owner_user_id],
            )
            .await?;
    }
    seed_group_participation_project(
        &pool,
        &org_id,
        &project_id,
        &owner_user_id,
        &other_user_id,
        variant,
    )
    .await?;
    pool.get()
        .await?
        .execute(
            "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
         values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
            &[&org_id, &project_id],
        )
        .await?;

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "ambient-telemetry-billing",
    );
    // Pin fixture prices; production model/rate changes must not rewrite the assertion.
    config.managed_ai_input_usd_micros_per_1k = 250;
    config.managed_ai_cached_input_usd_micros_per_1k = 25;
    config.managed_ai_output_usd_micros_per_1k = 2000;
    config.billing_units_per_usd = 1000;
    let state = build_test_state(pool.clone(), config.clone());
    let mut request = ambient_group_dispatch_request(&project_id, &conversation_id)?;
    if automation {
        // The scheduler creates its conversation before dispatching a root
        // automation. Match that contract rather than requesting a child thread.
        let connection = pool.get().await?;
        connection.execute(
            "insert into conversations (id, project_id, created_by, metadata, visibility, thread_kind)
             values ($1, $2, $3, '{}'::jsonb, 'private', 'automation')",
            &[&conversation_id, &project_id, &owner_user_id],
        ).await?;
        connection
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
             values ($1, $2, 'owner', $2)",
                &[&conversation_id, &owner_user_id],
            )
            .await?;
        request.thread_kind = Some("automation".to_string());
        request.conversation_metadata = Some(json!({ "visibility": "private" }));
        request.allow_silent_automation_decline = true;
        request.metadata["managedAiBillingDeferred"] = json!(true);
    }
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
    .map_err(|error| controller_error("dispatch telemetry billing fixture", error))?;
    assert_eq!(response.status, "queued");
    let run_id = response.run_id.expect("ambient run");
    let connection = pool.get().await?;
    let job_id: Uuid = connection
        .query_one(
            "select id from agent_jobs where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get("id");
    let prompt_id: Uuid = connection
        .query_one(
            "select id from prompts where conversation_id = $1",
            &[&conversation_id],
        )
        .await?
        .get("id");
    connection
        .execute(
            "update agent_jobs set status = 'leased' where id = $1",
            &[&job_id],
        )
        .await?;
    let initial_metadata = connection
        .query_one("select metadata from prompts where id = $1", &[&prompt_id])
        .await?
        .get::<_, PgJson<serde_json::Value>>("metadata")
        .0;
    let initial_participation = initial_metadata["groupParticipation"].clone();
    if automation {
        assert_eq!(
            initial_metadata["managedAiBillingDeferred"],
            json!(true),
            "the untrusted flag must survive to exercise the billing provenance guard"
        );
    }
    assert_eq!(
        initial_participation["reason"],
        json!(if automation {
            crate::group_participation::AUTOMATION_NOTHING_TO_REPORT_REASON
        } else {
            crate::group_participation::SKILL_MODE_AMBIENT_REASON
        })
    );
    drop(connection);
    let _watch = state.events.watch_project(project_id);
    let mut credit_events = state.events.subscribe();

    let token = mint_agent_message_token(&config, &project_id)?;
    for (message_type, content) in [
        (
            "token_usage",
            "Token usage — input: 4000, cached: 0, output: 2000",
        ),
        (
            "reasoning",
            "Checking whether this conversation turn is mine to answer.",
        ),
        (
            "learn_router",
            "Loaded learned blocks: blocks/testing/SKILL.md",
        ),
        ("todo_list", "Plan update: 0/1 steps complete"),
        ("browser_decision", "Tool call completed: browser/decide"),
        ("error", "Temporary provider stream error"),
        ("goal_update", "Goal progress updated"),
    ] {
        let status = post_agent_endpoint(
            &state,
            &token,
            "/agent/message",
            json!({
                "job_id": job_id, "content": content, "message_type": message_type,
                "metadata": if message_type == "goal_update" {
                    json!({ "messageType":"goal_update", "details": { "status":"running" },
                        "presentation": { "hidden":true } })
                } else { json!({}) },
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let connection = pool.get().await?;
        let count: i64 = connection
            .query_one(
                "select count(*)::bigint from org_credit_ledger
             where project_id = $1 and reason <> 'test_seed'",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(count, 0, "{variant}: {message_type} must not spend credits");
        let payload: PgJson<serde_json::Value> = connection
            .query_one("select payload from agent_jobs where id = $1", &[&job_id])
            .await?
            .get("payload");
        assert_eq!(
            payload.0["metadata"]["managedAiUsed"],
            json!(false),
            "{variant}: telemetry must not mark a managed prompt used"
        );
        assert_eq!(
            payload.0["metadata"]["aiAccessMode"],
            json!(if managed_access { "managed" } else { "byoc" }),
            "{variant}: use the actual dispatched access mode"
        );
        let prompt: PgJson<serde_json::Value> = connection
            .query_one("select metadata from prompts where id = $1", &[&prompt_id])
            .await?
            .get("metadata");
        assert_eq!(prompt.0["managedAiUsed"], json!(false));
    }
    assert_eq!(queued_credit_signals(&mut credit_events, project_id), 0);
    let activity_count: i64 = pool.get().await?.query_one(
        "select count(*)::bigint from activity_events where project_id = $1 and run_id = $2 and kind = 'conversation.reply'",
        &[&project_id, &run_id]
    ).await?.get(0);
    assert_eq!(
        activity_count, 0,
        "telemetry must not create reply activity"
    );
    let mut streamed_answer_seen = false;
    for content in streamed_messages {
        let had_streamed_answer = streamed_answer_seen;
        assert_eq!(
            post_agent_endpoint(
                &state,
                &token,
                "/agent/message",
                json!({ "job_id": job_id, "content": content, "message_type": "status",
                    "metadata": { "kind": "agent_message" } })
            )
            .await?,
            StatusCode::OK
        );
        streamed_answer_seen |= *content != "NO_RESPONSE";
        assert_eq!(
            queued_credit_signals(&mut credit_events, project_id),
            usize::from(should_bill && streamed_answer_seen && !had_streamed_answer),
            "only the first streamed answer publishes a committed reserve"
        );
        let expected_participation = if streamed_answer_seen {
            initial_participation.clone()
        } else {
            crate::group_participation::agent_declined_marker()
        };
        let row = pool
            .get()
            .await?
            .query_one(
                "select j.payload, r.metadata as run_metadata from agent_jobs j
             join runs r on r.id = j.run_id where j.id = $1",
                &[&job_id],
            )
            .await?;
        let payload = row.get::<_, PgJson<serde_json::Value>>("payload").0;
        let run = row.get::<_, PgJson<serde_json::Value>>("run_metadata").0;
        assert_eq!(
            payload["metadata"]["groupParticipation"], expected_participation,
            "{variant}: streamed output must immediately update the job decision"
        );
        assert_eq!(
            run["groupParticipation"], expected_participation,
            "{variant}: streamed output must immediately update the run decision"
        );
        assert_eq!(
            payload["metadata"]["managedAiUsed"],
            json!(managed_access && streamed_answer_seen)
        );
    }

    // The default fixture rates make this usage exactly five billing units.
    // Including it proves completion reads the newly persisted managed-use mark
    // before reconciliation, without charging a silent turn for its telemetry.
    let mut completion = json!({
        "job_id": job_id, "outcome": "succeeded",
        "artifacts": [{
            "kind": "codex/run-log",
            "events": [{ "type": "turn.completed", "usage": {
                "input_tokens": 4000, "cached_input_tokens": 0, "output_tokens": 2000
            }}]
        }],
    });
    if let Some(summary) = completion_answer {
        completion["summary"] = json!(summary);
    }
    assert_eq!(
        post_agent_endpoint(&state, &token, "/agent/complete", completion).await?,
        StatusCode::OK
    );

    if should_bill {
        // The controller coalesces rapid same-org credit updates for two seconds.
        // Completion-only answers publish immediately; an adjustment shortly
        // after streaming may arrive through that existing trailing signal.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = credit_events.recv().await?;
                if event.kind == crate::credits::CREDITS_UPDATED_EVENT
                    && event.project_id == Some(project_id)
                {
                    assert_eq!(event.data, json!({ "reason": "ledger" }));
                    return Ok::<_, anyhow::Error>(());
                }
            }
        })
        .await??;
    }
    assert_eq!(queued_credit_signals(&mut credit_events, project_id), 0);
    let connection = pool.get().await?;
    let charge = connection
        .query_one(
            "select count(*) filter (where reason = 'managed_ai_prompt')::bigint as reserves,
                count(*) filter (where reason = 'managed_ai_adjustment')::bigint as adjustments,
                coalesce(sum(delta) filter (where reason in ('managed_ai_prompt', 'managed_ai_adjustment')), 0)::bigint as total
         from org_credit_ledger where project_id = $1",
            &[&project_id],
        )
        .await?;
    assert_eq!(
        charge.get::<_, i64>("reserves"),
        if should_bill { 1 } else { 0 },
        "{variant}: at most one managed prompt reserve"
    );
    assert_eq!(
        charge.get::<_, i64>("adjustments"),
        if should_bill { 1 } else { 0 },
        "{variant}: only a spoken turn is reconciled"
    );
    assert_eq!(
        charge.get::<_, i64>("total"),
        if should_bill { -5 } else { 0 },
        "{variant}: correct final credit charge"
    );
    let payload: PgJson<serde_json::Value> = connection
        .query_one("select payload from agent_jobs where id = $1", &[&job_id])
        .await?
        .get("payload");
    assert_eq!(payload.0["metadata"]["managedAiUsed"], json!(should_bill));
    let prompt: PgJson<serde_json::Value> = connection
        .query_one("select metadata from prompts where id = $1", &[&prompt_id])
        .await?
        .get("metadata");
    assert_eq!(prompt.0["managedAiUsed"], json!(should_bill));
    let run: PgJson<serde_json::Value> = connection
        .query_one("select metadata from runs where id = $1", &[&run_id])
        .await?
        .get("metadata");
    assert_eq!(run.0["managedAiUsed"], json!(should_bill));
    if should_bill {
        assert_eq!(run.0["managedAiCredit"]["charge"]["chargedUnits"], json!(5));
    }
    let expected_participation = if expects_answer {
        initial_participation.clone()
    } else {
        crate::group_participation::agent_declined_marker()
    };
    assert_eq!(
        payload.0["metadata"]["groupParticipation"], expected_participation,
        "{variant}: the job must not advertise a decline after speaking"
    );
    assert_eq!(
        run.0["groupParticipation"], expected_participation,
        "{variant}: the run must not advertise a decline after speaking"
    );

    let visible: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
         where conversation_id = $1 and role = 'assistant'
           and coalesce(metadata ->> 'kind', '') <> 'runtime_alert'
           and metadata #> '{presentation,hidden}' is distinct from 'true'::jsonb
           and metadata #> '{details,presentation,hidden}' is distinct from 'true'::jsonb
           and lower(coalesce(metadata ->> 'messageType', metadata ->> 'message_type', ''))
               not in ('token_usage', 'reasoning', 'learn_router', 'todo_list', 'browser_decision', 'error')",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(
        visible,
        if expects_answer {
            streamed_messages
                .iter()
                .filter(|message| **message != "NO_RESPONSE")
                .count() as i64
                + i64::from(completion_answer.is_some())
        } else {
            0
        },
        "{variant}: telemetry and declines must not manufacture a visible answer"
    );
    let sentinels: i64 = connection
        .query_one(
            "select count(*)::bigint from conversation_messages
         where conversation_id = $1 and content = 'NO_RESPONSE'",
            &[&conversation_id],
        )
        .await?
        .get(0);
    assert_eq!(
        sentinels,
        if expects_answer && completion_answer == Some("NO_RESPONSE") {
            1
        } else {
            0
        },
        "{variant}: only a sentinel after a visible answer may persist"
    );
    eprintln!("billing contract {variant}: reserve_rows={}, adjustment_rows={}, credit_delta={}, visible_answers={visible}",
        charge.get::<_, i64>("reserves"), charge.get::<_, i64>("adjustments"), charge.get::<_, i64>("total"));
    drop(connection);
    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_user_id).await?;
    cleanup_test_user(&pool, &other_user_id).await?;
    Ok(())
}

#[tokio::test]
async fn skill_mode_telemetry_then_completion_decline_has_no_charge() -> anyhow::Result<()> {
    assert_ambient_telemetry_billing("completion decline", &[], Some("NO_RESPONSE"), false).await
}

#[tokio::test]
async fn skill_mode_streamed_decline_completion_remains_silent() -> anyhow::Result<()> {
    assert_ambient_telemetry_billing(
        "streamed decline with completion sentinel",
        &["NO_RESPONSE"],
        Some("NO_RESPONSE"),
        false,
    )
    .await?;
    assert_ambient_telemetry_billing(
        "streamed decline with generated completion",
        &["NO_RESPONSE"],
        None,
        false,
    )
    .await
}

#[tokio::test]
async fn skill_mode_completion_answer_bills_after_telemetry() -> anyhow::Result<()> {
    assert_ambient_telemetry_billing(
        "completion-only answer",
        &[],
        Some("The configured retry cap is four."),
        true,
    )
    .await
}

#[tokio::test]
async fn skill_mode_streamed_answer_completion_bills_once() -> anyhow::Result<()> {
    assert_ambient_telemetry_billing(
        "streamed and final answer",
        &["The retry cap is four."],
        Some("It applies to the standard tier."),
        true,
    )
    .await?;
    assert_ambient_telemetry_billing(
        "sentinel after visible answer",
        &["The retry cap is four."],
        Some("NO_RESPONSE"),
        true,
    )
    .await
}

#[tokio::test]
async fn skill_mode_answer_after_decline_bills_once() -> anyhow::Result<()> {
    assert_ambient_telemetry_billing(
        "completion answer after streamed decline",
        &["NO_RESPONSE"],
        Some("The configured retry cap is four."),
        true,
    )
    .await?;
    assert_ambient_telemetry_billing(
        "streamed answer after streamed decline",
        &["NO_RESPONSE", "The retry cap is four."],
        Some("It applies to the standard tier."),
        true,
    )
    .await
}

#[tokio::test]
async fn skill_mode_byoc_decline_and_resumed_answers_update_participation() -> anyhow::Result<()> {
    assert_ambient_telemetry_for_access_mode(
        "BYOC streamed decline",
        &["NO_RESPONSE"],
        Some("NO_RESPONSE"),
        false,
        false,
        false,
    )
    .await?;
    assert_ambient_telemetry_for_access_mode(
        "BYOC completion answer after decline",
        &["NO_RESPONSE"],
        Some("The retry cap is four."),
        true,
        false,
        false,
    )
    .await?;
    assert_ambient_telemetry_for_access_mode(
        "BYOC streamed answer after decline",
        &["NO_RESPONSE", "The retry cap is four."],
        Some("It applies to the standard tier."),
        true,
        false,
        false,
    )
    .await
}

#[tokio::test]
async fn automation_resuming_after_decline_preserves_billing_provenance() -> anyhow::Result<()> {
    for streamed in [false, true] {
        let messages: &[&str] = if streamed {
            &["NO_RESPONSE", "Dependency lockfile changed."]
        } else {
            &["NO_RESPONSE"]
        };
        assert_ambient_telemetry_for_access_mode(
            "BYOC automation with forged deferred flag",
            messages,
            Some("Dependency lockfile changed."),
            true,
            false,
            true,
        )
        .await?;
    }
    Ok(())
}
