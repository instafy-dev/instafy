//! Platform AI jobs (an AI job whose target has no credential) run only on
//! Instafy-hosted runtimes. A managed dispatch to a desktop or self-hosted
//! runtime is refused before any reserve, an ambient managed participant
//! there is skipped, and such a runtime never leases a platform job. The
//! service-role dispatches of a skill-authored plan, pinned or spread over
//! only private runtimes, are refused the same way and the plan fails
//! visibly. The idle sweep fails such a job that is already queued.

use super::*;

const SELF_HOSTED_REFUSAL: &str =
    "Instafy AI runs on Instafy-hosted runtimes. Connect your own AI to use this runtime.";
const SELF_HOSTED_REFUSAL_CODE: &str = "managed_ai_hosted_runtime_required";

/// Assert that `result` is the refusal of a platform dispatch pinned to the
/// private runtime `runtime_id`.
fn assert_hosted_runtime_refusal<T: std::fmt::Debug>(
    result: Result<T, (StatusCode, axum::Json<ApiError>)>,
    runtime_id: Uuid,
    case: &str,
) {
    let (status, axum::Json(error)) = result.expect_err(case);
    assert_eq!(status, StatusCode::BAD_REQUEST, "{case}");
    assert_eq!(error.message, SELF_HOSTED_REFUSAL, "{case}");
    assert_eq!(
        error.code.as_deref(),
        Some(SELF_HOSTED_REFUSAL_CODE),
        "{case}"
    );
    assert_eq!(
        error.details,
        Some(json!({ "runtimeIds": [runtime_id] })),
        "{case}"
    );
}

/// A ready desktop runtime privately owned by `owner`, bound to `generation`.
async fn insert_private_runtime(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
    owner: &Uuid,
    generation: &Uuid,
) -> anyhow::Result<()> {
    let mut capabilities = json!({
        "agent": true,
        "origin": true,
        "_instafyRuntimeTokenGeneration": generation,
    });
    runtime::set_self_hosted_access_attestation(
        capabilities
            .as_object_mut()
            .expect("runtime capabilities are an object"),
        *owner,
    );
    insert_ready_runtime(pool, project_id, runtime_id, "self-hosted", capabilities).await
}

async fn insert_ready_runtime(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
    provider: &str,
    capabilities: serde_json::Value,
) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at, capabilities
             ) values ($1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), $5)",
            &[
                runtime_id,
                project_id,
                &provider,
                &format!("platform-lane-{runtime_id}"),
                &PgJson(capabilities),
            ],
        )
        .await?;
    Ok(())
}

fn owner_context(user_id: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(user_id),
        is_service_role: false,
        scoped_claims: None,
    }
}

fn platform_lane_dispatch_request(
    project_id: &Uuid,
    conversation_id: &Uuid,
    runtime_id: &Uuid,
    agents: &[&str],
    visibility: &str,
) -> anyhow::Result<dispatch::DispatchPromptNormalized> {
    dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: None,
        prompt_text: Some("Should we keep the blue version?".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": agents, "mentions": [] }
        })),
        conversation_metadata: Some(json!({ "visibility": visibility })),
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation_id.to_string()),
        runtime_id: Some(runtime_id.to_string()),
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize platform lane dispatch", error))
}

#[tokio::test]
async fn managed_dispatch_to_self_hosted_runtime_refused_without_reserve_or_slot(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted managed dispatch test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let owner_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let desktop_runtime_id = Uuid::new_v4();
    let hosted_runtime_id = Uuid::new_v4();
    let octo_agent_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;

    let test_result: anyhow::Result<()> = async {
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name)
                     values ($1, $2, 'Self-hosted managed dispatch')",
                    &[&org_id, &format!("self-hosted-managed-{org_id}")],
                )
                .await?;
            connection
                .execute(
                    "insert into org_memberships (org_id, user_id, role)
                     values ($1, $2, 'owner')",
                    &[&org_id, &owner_user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, owner_user_id, project_type, status)
                     values ($1, $2, $3, 'customer', 'active')",
                    &[&project_id, &org_id, &owner_user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                     values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                    &[&org_id, &project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into user_agents (id, user_id, provider, handle, avatar_seed)
                     values ($1, $2, 'openai', 'octo', 'octo')",
                    &[&octo_agent_id, &owner_user_id],
                )
                .await?;
        }
        insert_private_runtime(
            &pool,
            &project_id,
            &desktop_runtime_id,
            &owner_user_id,
            &Uuid::new_v4(),
        )
        .await?;
        insert_ready_runtime(
            &pool,
            &project_id,
            &hosted_runtime_id,
            "instafy-cloud",
            json!({ "agent": true, "origin": true }),
        )
        .await?;

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "self-hosted-managed-dispatch",
        );
        // The managed gate passes, so only the runtime can refuse.
        config.managed_ai_openai_api_key = Some("sk-managed-test".to_string());
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: "instafy-cloud".to_string(),
            display_name: "Instafy Cloud".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        }];
        let state = build_test_state(pool.clone(), config);

        let assert_nothing_spent = |case: &'static str| {
            let pool = pool.clone();
            async move {
                let connection = pool.get().await?;
                for (table, predicate) in [
                    ("prompts", "project_id = $1"),
                    ("runs", "project_id = $1"),
                    ("agent_jobs", "project_id = $1"),
                    (
                        "org_credit_ledger",
                        "project_id = $1 and reason <> 'test_seed'",
                    ),
                ] {
                    let count: i64 = connection
                        .query_one(
                            &format!("select count(*)::bigint from {table} where {predicate}"),
                            &[&project_id],
                        )
                        .await?
                        .get(0);
                    anyhow::ensure!(count == 0, "{case}: {table} has {count} rows");
                }
                drop(connection);
                let mut connection = pool.get().await?;
                let transaction = connection.transaction().await?;
                let daily_prompts_used = credentials::count_recent_managed_ai_prompts(
                    &transaction,
                    Some(owner_user_id),
                    Utc::now() - ChronoDuration::hours(24),
                )
                .await
                .map_err(|error| controller_error("count managed prompts", error))?;
                anyhow::ensure!(daily_prompts_used == 0, "{case}: a daily slot was used");
                Ok::<(), anyhow::Error>(())
            }
        };

        // The composer's runtime is the desktop.
        let refused = dispatch::process_dispatch_prompt(
            &state,
            &owner_context(owner_user_id),
            platform_lane_dispatch_request(
                &project_id,
                &conversation_id,
                &desktop_runtime_id,
                &["octo"],
                "private",
            )?,
        )
        .await;
        assert_hosted_runtime_refusal(
            refused,
            desktop_runtime_id,
            "a managed dispatch to a desktop runtime is refused",
        );
        assert_nothing_spent("desktop composer runtime").await?;

        // The agent is pinned to the desktop while the composer runtime is
        // hosted: its platform target still resolves to the desktop.
        pool.get()
            .await?
            .execute(
                "insert into user_agent_project_settings (user_id, project_id, agent_id, runtime_id)
                 values ($1, $2, $3, $4)",
                &[&owner_user_id, &project_id, &octo_agent_id, &desktop_runtime_id],
            )
            .await?;
        let refused = dispatch::process_dispatch_prompt(
            &state,
            &owner_context(owner_user_id),
            platform_lane_dispatch_request(
                &project_id,
                &conversation_id,
                &hosted_runtime_id,
                &["octo"],
                "private",
            )?,
        )
        .await;
        assert_hosted_runtime_refusal(
            refused,
            desktop_runtime_id,
            "a managed agent pinned to a desktop runtime is refused",
        );
        assert_nothing_spent("agent pinned to the desktop").await?;

        // With managed AI off (the self-host default) the credential-less
        // lane is not Instafy AI, so both desktop routes get the managed
        // gate's own refusal rather than a pointer to hosted runtimes.
        let mut disabled_config = state.config.clone();
        disabled_config.managed_ai_enabled = false;
        let disabled_state = build_test_state(pool.clone(), disabled_config);
        for (case, composer_runtime_id) in [
            (
                "managed AI off, desktop composer runtime",
                desktop_runtime_id,
            ),
            (
                "managed AI off, agent pinned to the desktop",
                hosted_runtime_id,
            ),
        ] {
            let refused = dispatch::process_dispatch_prompt(
                &disabled_state,
                &owner_context(owner_user_id),
                platform_lane_dispatch_request(
                    &project_id,
                    &conversation_id,
                    &composer_runtime_id,
                    &["octo"],
                    "private",
                )?,
            )
            .await
            .expect_err("a credential-less dispatch with managed AI off is refused");
            assert_eq!(refused.0, StatusCode::BAD_REQUEST, "{case}");
            assert_eq!(
                refused.1 .0.message,
                "Connect your own AI to continue. Managed Instafy AI is unavailable right now.",
                "{case}"
            );
            assert_nothing_spent(case).await?;
        }

        // The same dispatch on the hosted runtime passes the gate and burns
        // the reserve, so the refusals above were the runtime's alone.
        pool.get()
            .await?
            .execute(
                "delete from user_agent_project_settings where agent_id = $1",
                &[&octo_agent_id],
            )
            .await?;
        let accepted = dispatch::process_dispatch_prompt(
            &state,
            &owner_context(owner_user_id),
            platform_lane_dispatch_request(
                &project_id,
                &conversation_id,
                &hosted_runtime_id,
                &["octo"],
                "private",
            )?,
        )
        .await
        .map_err(|error| controller_error("managed dispatch to hosted runtime", error))?;
        let job_id = accepted.job_id.expect("hosted managed job");
        let connection = pool.get().await?;
        let job = connection
            .query_one(
                "select target_runtime_id, credential_id from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(
            job.get::<_, Option<Uuid>>("target_runtime_id"),
            Some(hosted_runtime_id)
        );
        assert_eq!(job.get::<_, Option<Uuid>>("credential_id"), None);
        let reserves: i64 = connection
            .query_one(
                "select count(*)::bigint from org_credit_ledger
                 where project_id = $1 and reason = 'managed_ai_prompt'",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(reserves, 1, "the hosted dispatch burns its reserve");
        Ok(())
    }
    .await;

    let project_cleanup = cleanup_origin_project(&pool, &project_id).await;
    let org_cleanup = cleanup_org(&pool, &org_id).await;
    let user_cleanup = cleanup_test_user(&pool, &owner_user_id).await;
    test_result?;
    project_cleanup?;
    org_cleanup?;
    user_cleanup?;
    Ok(())
}

#[tokio::test]
async fn ambient_managed_participant_on_self_hosted_runtime_skipped() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted ambient participant test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let desktop_runtime_id = Uuid::new_v4();
    let reviewer_credential_id = Uuid::new_v4();
    let reviewer_agent_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;

    let test_result: anyhow::Result<()> = async {
        seed_group_participation_project(
            &pool,
            &org_id,
            &project_id,
            &owner_user_id,
            &other_user_id,
            "Self-hosted ambient participant",
        )
        .await?;
        seed_custom_agent(
            &pool,
            &owner_user_id,
            &reviewer_credential_id,
            &reviewer_agent_id,
            "reviewer",
            "Reviews frontend changes",
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
        insert_private_runtime(
            &pool,
            &project_id,
            &desktop_runtime_id,
            &owner_user_id,
            &Uuid::new_v4(),
        )
        .await?;

        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "self-hosted-ambient-participant",
        );
        let state = build_test_state(pool.clone(), config);
        let mut events = state.events.subscribe();

        let response = dispatch::process_dispatch_prompt(
            &state,
            &owner_context(owner_user_id),
            platform_lane_dispatch_request(
                &project_id,
                &conversation_id,
                &desktop_runtime_id,
                &["octo", "reviewer"],
                "public",
            )?,
        )
        .await
        .map_err(|error| controller_error("ambient dispatch on desktop runtime", error))?;
        assert_eq!(response.status, "queued", "the human's turn is not refused");

        let connection = pool.get().await?;
        let jobs = connection
            .query(
                "select run_id, credential_id, target_runtime_id, payload
                 from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(jobs.len(), 1, "only the BYO participant gets a job");
        let reviewer_run_id: Uuid = jobs[0].get("run_id");
        let payload = jobs[0].get::<_, PgJson<serde_json::Value>>("payload").0;
        assert_eq!(payload["metadata"]["agent"]["handle"], "reviewer");
        assert_eq!(
            jobs[0].get::<_, Option<Uuid>>("credential_id"),
            Some(reviewer_credential_id)
        );
        assert_eq!(
            jobs[0].get::<_, Option<Uuid>>("target_runtime_id"),
            Some(desktop_runtime_id)
        );
        let roster = payload["metadata"]["groupAiParticipants"]
            .as_array()
            .expect("the evaluation roster")
            .iter()
            .map(|entry| entry["handle"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            roster,
            vec![json!("reviewer")],
            "a skipped participant is not listed as evaluating"
        );

        let octo_run = connection
            .query_one(
                "select id, status, metadata from runs
                 where prompt_id = $1 and metadata #>> '{agent,handle}' = 'octo'",
                &[&response.prompt_id.expect("prompt id")],
            )
            .await?;
        let octo_run_id: Uuid = octo_run.get("id");
        let octo_metadata = octo_run.get::<_, PgJson<serde_json::Value>>("metadata").0;
        assert_eq!(octo_run.get::<_, String>("status"), "canceled");
        assert_eq!(
            octo_metadata["managedAiSkipped"],
            json!({ "reason": "self_hosted_runtime" })
        );
        assert!(octo_metadata.get("jobId").is_none());

        let messages = connection
            .query(
                "select role from conversation_messages where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .iter()
            .map(|row| row.get::<_, String>("role"))
            .collect::<Vec<_>>();
        assert_eq!(
            messages,
            vec!["user".to_string()],
            "the human's message lands and nothing is written for the agent"
        );
        let ledger_rows: i64 = connection
            .query_one(
                "select count(*)::bigint from org_credit_ledger
                 where project_id = $1 and reason <> 'test_seed'",
                &[&project_id],
            )
            .await?
            .get(0);
        assert_eq!(ledger_rows, 0);

        // The skipped run is never queued; it only settles as canceled. (The
        // human message still names it as the prompt's primary run.)
        let mut octo_events = Vec::new();
        let mut reviewer_queued = false;
        while let Ok(event) = events.try_recv() {
            if event.run_id == Some(octo_run_id) && event.kind.starts_with("run.") {
                octo_events.push((event.kind.clone(), event.data.clone()));
            }
            reviewer_queued |= event.run_id == Some(reviewer_run_id) && event.kind == "run.queued";
        }
        assert!(reviewer_queued);
        assert_eq!(octo_events.len(), 1, "{octo_events:?}");
        assert_eq!(octo_events[0].0, "run.completed");
        assert_eq!(octo_events[0].1["outcome"], "canceled");
        assert_eq!(
            octo_events[0].1["managedAiSkipped"]["reason"],
            "self_hosted_runtime"
        );
        Ok(())
    }
    .await;

    let project_cleanup = cleanup_origin_project(&pool, &project_id).await;
    let org_cleanup = cleanup_org(&pool, &org_id).await;
    let owner_cleanup = cleanup_test_user(&pool, &owner_user_id).await;
    let other_cleanup = cleanup_test_user(&pool, &other_user_id).await;
    test_result?;
    project_cleanup?;
    org_cleanup?;
    owner_cleanup?;
    other_cleanup?;
    Ok(())
}

/// Lease through `app`'s `/agent/lease` as `runtime_id` of `project_id` until
/// it gets nothing, and return what it got.
async fn lease_all_jobs(
    app: &axum::Router,
    config: &AppConfig,
    project_id: Uuid,
    runtime_id: Uuid,
    generation: Option<Uuid>,
) -> anyhow::Result<Vec<Uuid>> {
    let token = crate::auth::issue_agent_token(config, &project_id, &runtime_id, None, generation)
        .map_err(|error| controller_error("issue agent token", error))?
        .token;
    let mut leased = Vec::new();
    loop {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/agent/lease")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::from(json!({ "max": 1 }).to_string()))?,
            )
            .await?;
        let status = response.status();
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        anyhow::ensure!(status == StatusCode::OK, "lease returned {status}: {body}");
        let jobs = body["jobs"].as_array().cloned().unwrap_or_default();
        if jobs.is_empty() {
            return Ok(leased);
        }
        for job in jobs {
            leased.push(Uuid::parse_str(job["id"].as_str().unwrap_or_default())?);
        }
    }
}

/// Stop `runtime_id` as an idle stop leaves it: stopped, with no live lease
/// and a heartbeat long past.
async fn stop_runtime(pool: &PgPool, runtime_id: &Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update runtimes
             set status = 'stopped', last_seen_at = now() - interval '1 hour'
             where id = $1",
            &[runtime_id],
        )
        .await?;
    Ok(())
}

/// An ambient managed participant is skipped by the same rule a dispatch is
/// refused by. On the owner's stopped desktop it is not skipped: its job, like
/// the own-key participant's, is unpinned from the desktop once queued, and
/// the hosted runtime of the space takes it.
#[tokio::test]
async fn ambient_managed_participant_on_a_stopped_desktop_falls_back_to_a_hosted_runtime(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping stopped desktop ambient participant test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let owner_user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let desktop_runtime_id = Uuid::new_v4();
    let hosted_runtime_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_user_id).await?;
    ensure_test_user(&pool, &other_user_id).await?;

    let test_result: anyhow::Result<()> = async {
        seed_group_participation_project(
            &pool,
            &org_id,
            &project_id,
            &owner_user_id,
            &other_user_id,
            "Stopped desktop ambient participant",
        )
        .await?;
        seed_custom_agent(
            &pool,
            &owner_user_id,
            &Uuid::new_v4(),
            &Uuid::new_v4(),
            "reviewer",
            "Reviews frontend changes",
        )
        .await?;
        insert_private_runtime(
            &pool,
            &project_id,
            &desktop_runtime_id,
            &owner_user_id,
            &Uuid::new_v4(),
        )
        .await?;
        stop_runtime(&pool, &desktop_runtime_id).await?;
        insert_ready_runtime(
            &pool,
            &project_id,
            &hosted_runtime_id,
            "instafy-cloud",
            json!({ "agent": true, "origin": true }),
        )
        .await?;

        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "stopped-desktop-ambient-participant",
        );
        let state = build_test_state(pool.clone(), config.clone());
        let response = dispatch::process_dispatch_prompt(
            &state,
            &owner_context(owner_user_id),
            platform_lane_dispatch_request(
                &project_id,
                &conversation_id,
                &desktop_runtime_id,
                &["octo", "reviewer"],
                "public",
            )?,
        )
        .await
        .map_err(|error| controller_error("ambient dispatch on a stopped desktop", error))?;
        assert_eq!(response.status, "queued");

        let connection = pool.get().await?;
        let jobs = connection
            .query(
                "select aj.id, aj.target_runtime_id, aj.payload #>> '{metadata,agent,handle}' as handle,
                        r.status as run_status, r.metadata as run_metadata
                 from agent_jobs aj
                 join runs r on r.id = aj.run_id
                 where aj.conversation_id = $1
                 order by handle",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(
            jobs.iter()
                .map(|job| job.get::<_, Option<String>>("handle"))
                .collect::<Vec<_>>(),
            vec![Some("octo".to_string()), Some("reviewer".to_string())],
            "both participants get a job"
        );
        for job in &jobs {
            assert_eq!(job.get::<_, Option<Uuid>>("target_runtime_id"), None);
            assert_ne!(job.get::<_, String>("run_status"), "canceled");
            assert!(job
                .get::<_, PgJson<serde_json::Value>>("run_metadata")
                .0
                .get("managedAiSkipped")
                .is_none());
        }
        let octo_job_id: Uuid = jobs[0].get("id");
        drop(connection);

        let app = agent::router().with_state(state.clone());
        let leased =
            lease_all_jobs(&app, &config, project_id, hosted_runtime_id, None).await?;
        assert!(
            leased.contains(&octo_job_id),
            "the hosted runtime takes the managed participant's job, got {leased:?}"
        );
        Ok(())
    }
    .await;

    let project_cleanup = cleanup_origin_project(&pool, &project_id).await;
    let org_cleanup = cleanup_org(&pool, &org_id).await;
    let owner_cleanup = cleanup_test_user(&pool, &owner_user_id).await;
    let other_cleanup = cleanup_test_user(&pool, &other_user_id).await;
    test_result?;
    project_cleanup?;
    org_cleanup?;
    owner_cleanup?;
    other_cleanup?;
    Ok(())
}

struct LeaseFixture {
    pool: PgPool,
    app: axum::Router,
    config: AppConfig,
    owner_user_id: Uuid,
    project_id: Uuid,
    desktop_runtime_id: Uuid,
    desktop_generation: Uuid,
}

impl LeaseFixture {
    async fn new(pool: PgPool, label: &str) -> anyhow::Result<Self> {
        Self::new_with_config(pool, label, |_| {}).await
    }

    async fn new_with_config(
        pool: PgPool,
        label: &str,
        configure: impl FnOnce(&mut AppConfig),
    ) -> anyhow::Result<Self> {
        let owner_user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let desktop_runtime_id = Uuid::new_v4();
        let desktop_generation = Uuid::new_v4();
        ensure_test_user(&pool, &owner_user_id).await?;
        pool.get()
            .await?
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &owner_user_id],
            )
            .await?;
        insert_private_runtime(
            &pool,
            &project_id,
            &desktop_runtime_id,
            &owner_user_id,
            &desktop_generation,
        )
        .await?;
        let mut config =
            build_app_config(test_origin_private_key(), test_origin_public_key(), label);
        configure(&mut config);
        let app = agent::router().with_state(build_test_state(pool.clone(), config.clone()));
        Ok(Self {
            pool,
            app,
            config,
            owner_user_id,
            project_id,
            desktop_runtime_id,
            desktop_generation,
        })
    }

    async fn insert_job(
        &self,
        intent: Option<&str>,
        credential_id: Option<Uuid>,
        target_runtime_id: Option<Uuid>,
    ) -> anyhow::Result<Uuid> {
        let job_id = Uuid::new_v4();
        self.pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs (
                     id, project_id, status, intent, credential_id, target_runtime_id, payload
                 ) values ($1, $2, 'queued', $3, $4, $5, $6)",
                &[
                    &job_id,
                    &self.project_id,
                    &intent,
                    &credential_id,
                    &target_runtime_id,
                    &PgJson(json!({
                        "user_id": self.owner_user_id,
                        "prompt_text": "Report the workspace status.",
                    })),
                ],
            )
            .await?;
        Ok(job_id)
    }

    async fn insert_credential(&self) -> anyhow::Result<Uuid> {
        let credential_id = Uuid::new_v4();
        self.pool
            .get()
            .await?
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata
                 ) values ($1, $2, 'openai_api_key', 'Lease test', 'test-nonce',
                     'test-ciphertext', '{}'::jsonb)",
                &[&credential_id, &self.owner_user_id],
            )
            .await?;
        Ok(credential_id)
    }

    /// Lease as `runtime_id` until it gets nothing, and return what it got.
    async fn lease_all(
        &self,
        runtime_id: Uuid,
        generation: Option<Uuid>,
    ) -> anyhow::Result<Vec<Uuid>> {
        lease_all_jobs(
            &self.app,
            &self.config,
            self.project_id,
            runtime_id,
            generation,
        )
        .await
    }

    async fn job_status(&self, job_id: &Uuid) -> anyhow::Result<(String, i32)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, lease_attempts from agent_jobs where id = $1",
                &[job_id],
            )
            .await?;
        Ok((row.get("status"), row.get("lease_attempts")))
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        let project_cleanup = cleanup_origin_project(&self.pool, &self.project_id).await;
        let user_cleanup = cleanup_test_user(&self.pool, &self.owner_user_id).await;
        project_cleanup?;
        user_cleanup
    }
}

#[tokio::test]
async fn self_hosted_runtime_does_not_lease_credentialless_ai_job() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted platform lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let fixture = LeaseFixture::new(pool, "self-hosted-platform-lease").await?;
    let test_result: anyhow::Result<()> = async {
        let pinned = fixture
            .insert_job(Some("feature"), None, Some(fixture.desktop_runtime_id))
            .await?;
        // A job without an intent predates the column and is an AI job.
        let unpinned = fixture.insert_job(None, None, None).await?;

        let leased = fixture
            .lease_all(fixture.desktop_runtime_id, Some(fixture.desktop_generation))
            .await?;
        assert!(leased.is_empty(), "the desktop leased {leased:?}");
        for job_id in [pinned, unpinned] {
            assert_eq!(
                fixture.job_status(&job_id).await?,
                ("queued".to_string(), 0)
            );
        }

        // A hosted runtime of the same space takes the unpinned platform job.
        let hosted_runtime_id = Uuid::new_v4();
        insert_ready_runtime(
            &fixture.pool,
            &fixture.project_id,
            &hosted_runtime_id,
            "instafy-cloud",
            json!({ "agent": true, "origin": true }),
        )
        .await?;
        let leased = fixture.lease_all(hosted_runtime_id, None).await?;
        assert_eq!(leased, vec![unpinned]);
        Ok(())
    }
    .await;
    let cleanup = fixture.cleanup().await;
    test_result?;
    cleanup
}

#[tokio::test]
async fn self_hosted_runtime_still_leases_byo_and_terminal_jobs() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted BYO lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let fixture = LeaseFixture::new(pool, "self-hosted-byo-lease").await?;
    let test_result: anyhow::Result<()> = async {
        let credential_id = fixture.insert_credential().await?;
        let desktop = Some(fixture.desktop_runtime_id);
        let byo = fixture
            .insert_job(Some("feature"), Some(credential_id), desktop)
            .await?;
        let byo_unpinned = fixture
            .insert_job(Some("question"), Some(credential_id), None)
            .await?;
        let terminal = fixture
            .insert_job(Some("terminal_command"), None, desktop)
            .await?;

        let mut leased = fixture
            .lease_all(fixture.desktop_runtime_id, Some(fixture.desktop_generation))
            .await?;
        leased.sort();
        let mut expected = vec![byo, byo_unpinned, terminal];
        expected.sort();
        assert_eq!(leased, expected);
        Ok(())
    }
    .await;
    let cleanup = fixture.cleanup().await;
    test_result?;
    cleanup
}

/// With managed AI off the credential-less lane is a proxy's own static key,
/// which belongs to the deployment, so a private runtime still never leases a
/// platform job.
#[tokio::test]
async fn private_runtime_does_not_lease_platform_jobs_with_managed_ai_off() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping managed-AI-off platform lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let fixture = LeaseFixture::new_with_config(pool, "managed-ai-off-platform-lease", |config| {
        config.managed_ai_enabled = false;
    })
    .await?;
    let test_result: anyhow::Result<()> = async {
        let pinned = fixture
            .insert_job(Some("feature"), None, Some(fixture.desktop_runtime_id))
            .await?;
        let unpinned = fixture.insert_job(Some("question"), None, None).await?;
        let terminal = fixture
            .insert_job(
                Some("terminal_command"),
                None,
                Some(fixture.desktop_runtime_id),
            )
            .await?;

        let leased = fixture
            .lease_all(fixture.desktop_runtime_id, Some(fixture.desktop_generation))
            .await?;
        assert_eq!(
            leased,
            vec![terminal],
            "only the terminal command is leased"
        );
        for job_id in [pinned, unpinned] {
            assert_eq!(
                fixture.job_status(&job_id).await?,
                ("queued".to_string(), 0)
            );
        }
        Ok(())
    }
    .await;
    let cleanup = fixture.cleanup().await;
    test_result?;
    cleanup
}

/// A runtime of a configured provider that is neither the canonical Instafy
/// Cloud id nor self-hosted (a self-hoster's own managed provider) is not
/// private, so it leases platform jobs, pinned or not.
#[tokio::test]
async fn non_private_custom_provider_runtime_still_leases_platform_jobs() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping custom provider platform lease test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let fixture = LeaseFixture::new_with_config(pool, "custom-provider-platform-lease", |config| {
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: "acme-cloud".to_string(),
            display_name: "Acme Cloud".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        }];
    })
    .await?;
    let test_result: anyhow::Result<()> = async {
        let acme_runtime_id = Uuid::new_v4();
        insert_ready_runtime(
            &fixture.pool,
            &fixture.project_id,
            &acme_runtime_id,
            "acme-cloud",
            json!({ "agent": true, "origin": true }),
        )
        .await?;
        let pinned = fixture
            .insert_job(Some("feature"), None, Some(acme_runtime_id))
            .await?;
        let unpinned = fixture.insert_job(Some("question"), None, None).await?;

        let mut leased = fixture.lease_all(acme_runtime_id, None).await?;
        leased.sort();
        let mut expected = vec![pinned, unpinned];
        expected.sort();
        assert_eq!(leased, expected);
        Ok(())
    }
    .await;
    let cleanup = fixture.cleanup().await;
    test_result?;
    cleanup
}

/// A space in an organization with credits: its owner with an `@octo` that
/// has no credential and no default credential, a ready desktop runtime the
/// owner attested, a ready hosted runtime and a ready runtime of a
/// non-canonical managed provider (`acme-cloud`).
struct ManagedSpace {
    pool: PgPool,
    owner_user_id: Uuid,
    org_id: Uuid,
    project_id: Uuid,
    desktop_runtime_id: Uuid,
    hosted_runtime_id: Uuid,
    acme_runtime_id: Uuid,
}

impl ManagedSpace {
    async fn seed(pool: PgPool, label: &str) -> anyhow::Result<Self> {
        let space = Self {
            pool,
            owner_user_id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            desktop_runtime_id: Uuid::new_v4(),
            hosted_runtime_id: Uuid::new_v4(),
            acme_runtime_id: Uuid::new_v4(),
        };
        ensure_test_user(&space.pool, &space.owner_user_id).await?;
        let seeded: anyhow::Result<()> = async {
            let connection = space.pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, $3)",
                    &[&space.org_id, &format!("{label}-{}", space.org_id), &label],
                )
                .await?;
            connection
                .execute(
                    "insert into org_memberships (org_id, user_id, role)
                     values ($1, $2, 'owner')",
                    &[&space.org_id, &space.owner_user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, owner_user_id, project_type, status)
                     values ($1, $2, $3, 'customer', 'active')",
                    &[&space.project_id, &space.org_id, &space.owner_user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                     values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                    &[&space.org_id, &space.project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into user_agents (id, user_id, provider, handle, avatar_seed)
                     values ($1, $2, 'openai', 'octo', 'octo')",
                    &[&Uuid::new_v4(), &space.owner_user_id],
                )
                .await?;
            drop(connection);
            insert_private_runtime(
                &space.pool,
                &space.project_id,
                &space.desktop_runtime_id,
                &space.owner_user_id,
                &Uuid::new_v4(),
            )
            .await?;
            for (runtime_id, provider) in [
                (space.hosted_runtime_id, "instafy-cloud"),
                (space.acme_runtime_id, "acme-cloud"),
            ] {
                insert_ready_runtime(
                    &space.pool,
                    &space.project_id,
                    &runtime_id,
                    provider,
                    json!({ "agent": true, "origin": true }),
                )
                .await?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = seeded {
            let _ = space.cleanup().await;
            return Err(error);
        }
        Ok(space)
    }

    /// A config whose managed gate passes (the controller holds the managed
    /// key), with both hosted providers configured.
    fn config(&self, label: &str) -> AppConfig {
        let mut config =
            build_app_config(test_origin_private_key(), test_origin_public_key(), label);
        config.managed_ai_openai_api_key = Some("sk-managed-test".to_string());
        config.runtime_providers = ["instafy-cloud", "acme-cloud"]
            .into_iter()
            .map(|id| RuntimeProviderConfig {
                id: id.to_string(),
                display_name: id.to_string(),
                kind: "noop".to_string(),
                owner_org_id: None,
                allowed_org_ids: vec![],
                endpoint: None,
                auth_token: None,
                metadata: None,
            })
            .collect();
        config
    }

    /// The owner sends a turn to `agents` in a new private conversation with
    /// the composer on `runtime_id`.
    async fn dispatch(
        &self,
        state: &AppState,
        context: &RequestContext,
        runtime_id: Uuid,
        agents: &[&str],
    ) -> Result<dispatch::DispatchPromptResponse, (StatusCode, axum::Json<ApiError>)> {
        let request = platform_lane_dispatch_request(
            &self.project_id,
            &Uuid::new_v4(),
            &runtime_id,
            agents,
            "private",
        )
        .expect("a valid dispatch request");
        dispatch::process_dispatch_prompt(state, context, request).await
    }

    async fn count(&self, table: &str, predicate: &str) -> anyhow::Result<i64> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                &format!("select count(*)::bigint from {table} where {predicate}"),
                &[&self.project_id],
            )
            .await?
            .get(0))
    }

    async fn cleanup(&self) -> anyhow::Result<()> {
        let project_cleanup = cleanup_origin_project(&self.pool, &self.project_id).await;
        let org_cleanup = cleanup_org(&self.pool, &self.org_id).await;
        let user_cleanup = cleanup_test_user(&self.pool, &self.owner_user_id).await;
        project_cleanup?;
        org_cleanup?;
        user_cleanup
    }
}

fn service_role_context(user_id: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(user_id),
        is_service_role: true,
        scoped_claims: None,
    }
}

/// Proxy credential-check reports (a `telemetry.system_issue.*` event) the
/// dispatches of `project_id` have published since the last call.
fn proxy_check_reports(
    events: &mut tokio::sync::broadcast::Receiver<crate::state::ControllerEvent>,
    project_id: Uuid,
) -> usize {
    let mut reports = 0;
    while let Ok(event) = events.try_recv() {
        if event.project_id == Some(project_id) && event.kind.starts_with("telemetry.system_issue.")
        {
            reports += 1;
        }
    }
    reports
}

/// The private-runtime refusal comes before each of the managed gate's own
/// refusals: the reserve (an unaffordable burn), the daily prompt count (the
/// day's one prompt used) and the proxy check (an unreachable proxy). The same
/// dispatch to the hosted runtime hits each of them, so they were live.
#[tokio::test]
async fn self_hosted_refusal_comes_before_the_proxy_check_daily_count_and_reserve(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted refusal order test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "self-hosted-refusal-order").await?;
    let test_result: anyhow::Result<()> = async {
        let owner = owner_context(space.owner_user_id);
        let desktop = space.desktop_runtime_id;
        let hosted = space.hosted_runtime_id;

        // The reserve refuses: the burn is more than the balance can be.
        let mut config = space.config("self-hosted-refusal-order-reserve");
        config.managed_ai_credit_burn_amount = 1_000_000;
        let state = build_test_state(space.pool.clone(), config);
        let refused = space
            .dispatch(&state, &owner, hosted, &["octo"])
            .await
            .expect_err("an unaffordable reserve is refused");
        assert_eq!(
            refused.1 .0.message,
            "insufficient credits available for requested burn"
        );
        assert_hosted_runtime_refusal(
            space.dispatch(&state, &owner, desktop, &["octo"]).await,
            desktop,
            "refused before the reserve",
        );

        // The daily count refuses: the day's one prompt is used.
        let mut config = space.config("self-hosted-refusal-order-daily");
        config.managed_ai_daily_prompt_limit = 1;
        let state = build_test_state(space.pool.clone(), config);
        space
            .dispatch(&state, &owner, hosted, &["octo"])
            .await
            .map_err(|error| controller_error("the day's one managed prompt", error))?;
        let refused = space
            .dispatch(&state, &owner, hosted, &["octo"])
            .await
            .expect_err("the daily limit refuses the second prompt");
        assert_eq!(
            refused.1 .0.message,
            "Connect your own AI to continue. You have used all 1 Instafy AI prompts available today."
        );
        assert_hosted_runtime_refusal(
            space.dispatch(&state, &owner, desktop, &["octo"]).await,
            desktop,
            "refused before the daily count",
        );

        // The proxy check refuses: nothing listens on the proxy's port, and
        // the check reports that as a system issue.
        let closed_port = std::net::TcpListener::bind("127.0.0.1:0")?
            .local_addr()?
            .port();
        let mut config = space.config("self-hosted-refusal-order-proxy");
        config.proxy_base_url = Some(format!("http://127.0.0.1:{closed_port}"));
        let state = build_test_state(space.pool.clone(), config);
        let mut events = state.events.subscribe();
        assert_hosted_runtime_refusal(
            space.dispatch(&state, &owner, desktop, &["octo"]).await,
            desktop,
            "refused before the proxy check",
        );
        assert_eq!(
            proxy_check_reports(&mut events, space.project_id),
            0,
            "the refused dispatch never probed the proxy"
        );
        let refused = space
            .dispatch(&state, &owner, hosted, &["octo"])
            .await
            .expect_err("an unreachable proxy refuses the managed turn");
        assert_eq!(
            refused.1 .0.message,
            "Connect your own AI to continue. This request needs a personal AI connection."
        );
        assert_eq!(proxy_check_reports(&mut events, space.project_id), 1);

        // Only the day's one prompt was admitted and reserved.
        assert_eq!(space.count("prompts", "project_id = $1").await?, 1);
        assert_eq!(space.count("agent_jobs", "project_id = $1").await?, 1);
        assert_eq!(
            space
                .count(
                    "org_credit_ledger",
                    "project_id = $1 and reason = 'managed_ai_prompt'"
                )
                .await?,
            1
        );
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// A service-role dispatch (a plan worker, a lead continuation, a queued send
/// with no user) has no managed gate. When its credential-less AI job would
/// be pinned to a private runtime it is refused, with managed AI on or off,
/// since that runtime would never lease it. The same dispatch to a hosted or
/// a non-canonical managed runtime, an own-key one to the desktop, and a
/// user's managed dispatch to the non-canonical runtime go ahead.
#[tokio::test]
async fn service_role_platform_dispatch_to_a_private_runtime_is_refused() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping service-role self-hosted dispatch test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "service-role-self-hosted").await?;
    let test_result: anyhow::Result<()> = async {
        let service = service_role_context(space.owner_user_id);
        let reviewer_credential_id = Uuid::new_v4();
        seed_custom_agent(
            &space.pool,
            &space.owner_user_id,
            &reviewer_credential_id,
            &Uuid::new_v4(),
            "reviewer",
            "Reviews changes with its own key",
        )
        .await?;

        for managed_ai_enabled in [true, false] {
            let mut config = space.config("service-role-self-hosted");
            config.managed_ai_enabled = managed_ai_enabled;
            let state = build_test_state(space.pool.clone(), config);
            assert_hosted_runtime_refusal(
                space
                    .dispatch(&state, &service, space.desktop_runtime_id, &["scout"])
                    .await,
                space.desktop_runtime_id,
                &format!("service-role worker to the desktop, managed AI {managed_ai_enabled}"),
            );
            for table in ["prompts", "runs", "agent_jobs"] {
                assert_eq!(
                    space.count(table, "project_id = $1").await?,
                    0,
                    "{table} after the refusal with managed AI {managed_ai_enabled}"
                );
            }
        }

        let state = build_test_state(space.pool.clone(), space.config("service-role-self-hosted"));
        let mut accepted = Vec::new();
        for (runtime_id, agent, credential_id) in [
            (space.hosted_runtime_id, "scout", None),
            (space.acme_runtime_id, "scout", None),
            (
                space.desktop_runtime_id,
                "reviewer",
                Some(reviewer_credential_id),
            ),
        ] {
            let response = space
                .dispatch(&state, &service, runtime_id, &[agent])
                .await
                .map_err(|error| controller_error("accepted service-role dispatch", error))?;
            accepted.push((
                response.job_id.expect("a queued job"),
                runtime_id,
                credential_id,
            ));
        }
        let connection = space.pool.get().await?;
        for (job_id, runtime_id, credential_id) in accepted {
            let job = connection
                .query_one(
                    "select target_runtime_id, credential_id from agent_jobs where id = $1",
                    &[&job_id],
                )
                .await?;
            assert_eq!(
                job.get::<_, Option<Uuid>>("target_runtime_id"),
                Some(runtime_id)
            );
            assert_eq!(job.get::<_, Option<Uuid>>("credential_id"), credential_id);
        }
        drop(connection);

        // The non-canonical managed runtime is not private, so a user's
        // managed dispatch to it passes the gate and takes its reserve.
        let response = space
            .dispatch(
                &state,
                &owner_context(space.owner_user_id),
                space.acme_runtime_id,
                &["octo"],
            )
            .await
            .map_err(|error| controller_error("managed dispatch to acme-cloud", error))?;
        let target: Option<Uuid> = space
            .pool
            .get()
            .await?
            .query_one(
                "select target_runtime_id from agent_jobs where id = $1",
                &[&response.job_id.expect("a queued managed job")],
            )
            .await?
            .get(0);
        assert_eq!(target, Some(space.acme_runtime_id));
        assert_eq!(
            space
                .count(
                    "org_credit_ledger",
                    "project_id = $1 and reason = 'managed_ai_prompt'"
                )
                .await?,
            1,
            "only the user's managed dispatch reserves; service-role ones do not"
        );
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// A platform dispatch to a desktop that is not dispatch-ready is unpinned
/// from it once queued, and a hosted runtime answers it, as before private
/// runtimes refused platform jobs. So a managed dispatch to the owner's
/// stopped desktop is queued, reserved, unpinned and leased by the hosted
/// runtime of the space, where the same dispatch to the ready desktop is
/// refused. An agent's own pin to the stopped desktop, with the composer on
/// the hosted runtime, is not unpinned, so it is still refused.
#[tokio::test]
async fn platform_dispatch_to_a_stopped_desktop_falls_back_to_a_hosted_runtime(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping stopped desktop fallback test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "stopped-desktop-fallback").await?;
    let test_result: anyhow::Result<()> = async {
        let config = space.config("stopped-desktop-fallback");
        let state = build_test_state(space.pool.clone(), config.clone());
        let owner = owner_context(space.owner_user_id);
        let desktop = space.desktop_runtime_id;
        assert_hosted_runtime_refusal(
            space.dispatch(&state, &owner, desktop, &["octo"]).await,
            desktop,
            "a managed dispatch to the ready desktop",
        );

        stop_runtime(&space.pool, &desktop).await?;
        let response = space
            .dispatch(&state, &owner, desktop, &["octo"])
            .await
            .map_err(|error| controller_error("managed dispatch to the stopped desktop", error))?;
        let job_id = response.job_id.expect("a queued managed job");
        let job = space
            .pool
            .get()
            .await?
            .query_one(
                "select status, target_runtime_id, credential_id from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(job.get::<_, String>("status"), "queued");
        assert_eq!(
            job.get::<_, Option<Uuid>>("target_runtime_id"),
            None,
            "the job is unpinned from the stopped desktop"
        );
        assert_eq!(job.get::<_, Option<Uuid>>("credential_id"), None);
        assert_eq!(
            space
                .count(
                    "org_credit_ledger",
                    "project_id = $1 and reason = 'managed_ai_prompt'"
                )
                .await?,
            1,
            "the managed turn is reserved as on a hosted runtime"
        );
        let app = agent::router().with_state(state.clone());
        assert_eq!(
            lease_all_jobs(
                &app,
                &config,
                space.project_id,
                space.hosted_runtime_id,
                None
            )
            .await?,
            vec![job_id],
            "the hosted runtime answers it"
        );

        // The agent's own pin to the stopped desktop is not this dispatch's
        // runtime, so nothing unpins it.
        let octo_agent_id: Uuid = space
            .pool
            .get()
            .await?
            .query_one(
                "select id from user_agents where user_id = $1 and handle = 'octo'",
                &[&space.owner_user_id],
            )
            .await?
            .get(0);
        space
            .pool
            .get()
            .await?
            .execute(
                "insert into user_agent_project_settings (user_id, project_id, agent_id, runtime_id)
                 values ($1, $2, $3, $4)",
                &[
                    &space.owner_user_id,
                    &space.project_id,
                    &octo_agent_id,
                    &desktop,
                ],
            )
            .await?;
        assert_hosted_runtime_refusal(
            space
                .dispatch(&state, &owner, space.hosted_runtime_id, &["octo"])
                .await,
            desktop,
            "a managed agent pinned to the stopped desktop",
        );
        assert_eq!(space.count("agent_jobs", "project_id = $1").await?, 1);
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// Backdate the queued `job_ids` past the idle sweep's grace for platform
/// jobs, as jobs queued before the last sweep ran are.
async fn age_past_the_stranded_job_grace(pool: &PgPool, job_ids: &[Uuid]) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update agent_jobs
             set created_at = now() - ($2::bigint + 1) * interval '1 second'
             where id = any($1)",
            &[&job_ids, &runtime::STRANDED_PLATFORM_JOB_GRACE_SECONDS],
        )
        .await?;
    Ok(())
}

/// Pin the queued `job_id` to `runtime_id`.
async fn pin_job(pool: &PgPool, job_id: Uuid, runtime_id: Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update agent_jobs set target_runtime_id = $2 where id = $1",
            &[&job_id, &runtime_id],
        )
        .await?;
    Ok(())
}

/// The status and error message of `job_id`.
async fn job_status_and_error(
    pool: &PgPool,
    job_id: Uuid,
) -> anyhow::Result<(String, Option<String>)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select status, error_message from agent_jobs where id = $1",
            &[&job_id],
        )
        .await?;
    Ok((row.get("status"), row.get("error_message")))
}

/// Dispatch commits a platform job pinned to a stopped desktop and unpins it
/// only after. An idle sweep that runs in between leaves the job alone, so the
/// hosted runtime still answers it. A job that stays pinned there, because the
/// desktop came back before the unpin, is failed once the grace has passed.
#[tokio::test]
async fn idle_sweep_leaves_a_job_that_dispatch_is_about_to_unpin() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping sweep before unpin test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "sweep-before-unpin").await?;
    let test_result: anyhow::Result<()> = async {
        let config = space.config("sweep-before-unpin");
        let state = build_test_state(space.pool.clone(), config.clone());
        let owner = owner_context(space.owner_user_id);
        let desktop = space.desktop_runtime_id;
        stop_runtime(&space.pool, &desktop).await?;

        let job_id = space
            .dispatch(&state, &owner, desktop, &["octo"])
            .await
            .map_err(|error| controller_error("managed dispatch to the stopped desktop", error))?
            .job_id
            .expect("a queued managed job");
        // The job as the dispatch's commit left it, before its unpin.
        pin_job(&space.pool, job_id, desktop).await?;
        runtime::sweep_idle_activity(&state).await?;
        assert_eq!(
            job_status_and_error(&space.pool, job_id).await?,
            ("queued".to_string(), None),
            "the sweep leaves a job that dispatch is about to unpin"
        );
        // The dispatch's unpin, and the hosted runtime answers.
        space
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set target_runtime_id = null
                 where id = $1 and status = 'queued' and target_runtime_id = $2",
                &[&job_id, &desktop],
            )
            .await?;
        let app = agent::router().with_state(state.clone());
        assert_eq!(
            lease_all_jobs(
                &app,
                &config,
                space.project_id,
                space.hosted_runtime_id,
                None
            )
            .await?,
            vec![job_id],
            "the hosted runtime answers it"
        );

        let kept_job_id = space
            .dispatch(&state, &owner, desktop, &["octo"])
            .await
            .map_err(|error| controller_error("second dispatch to the stopped desktop", error))?
            .job_id
            .expect("a queued managed job");
        pin_job(&space.pool, kept_job_id, desktop).await?;
        age_past_the_stranded_job_grace(&space.pool, &[kept_job_id]).await?;
        runtime::sweep_idle_activity(&state).await?;
        assert_eq!(
            job_status_and_error(&space.pool, kept_job_id).await?,
            ("failed".to_string(), Some(SELF_HOSTED_REFUSAL.to_string())),
            "a job left pinned to the desktop fails once the grace has passed"
        );
        assert_eq!(
            space
                .count(
                    "org_credit_ledger",
                    "project_id = $1 and reason = 'managed_ai_refund'"
                )
                .await?,
            1,
            "only the failed job's reserve is given back"
        );
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// Insert a conversation of the space, and a run and an agent job in it
/// leased by `runtime_id` for `credential_id`, with `metadata` on the job.
async fn insert_leased_plan_job(
    space: &ManagedSpace,
    runtime_id: Uuid,
    credential_id: Option<Uuid>,
    metadata: serde_json::Value,
) -> anyhow::Result<(Uuid, Uuid, Uuid, serde_json::Value)> {
    let conversation_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let payload = json!({
        "project_id": space.project_id,
        "conversation_id": conversation_id,
        "user_id": space.owner_user_id,
        "prompt_text": "Split this review across a team.",
        "metadata": metadata,
    });
    let connection = space.pool.get().await?;
    connection
        .execute(
            "insert into conversations (id, project_id, created_by, metadata, visibility)
             values ($1, $2, $3, '{}'::jsonb, 'private')",
            &[&conversation_id, &space.project_id, &space.owner_user_id],
        )
        .await?;
    connection
        .execute(
            "insert into runs (id, project_id, conversation_id, run_type, status)
             values ($1, $2, $3, 'prompt', 'in_progress')",
            &[&run_id, &space.project_id, &conversation_id],
        )
        .await?;
    connection
        .execute(
            "insert into agent_jobs (
                 id, project_id, run_id, conversation_id, status, intent, credential_id,
                 target_runtime_id, leased_by_runtime_id, leased_at, lease_expires_at,
                 lease_attempts, payload
             ) values ($1, $2, $3, $4, 'leased', 'feature', $5, $6, $6, now(),
                       now() + interval '5 minutes', 1, $7)",
            &[
                &job_id,
                &space.project_id,
                &run_id,
                &conversation_id,
                &credential_id,
                &runtime_id,
                &PgJson(payload.clone()),
            ],
        )
        .await?;
    Ok((conversation_id, run_id, job_id, payload))
}

/// A plan authored on a desktop by an own-key agent, whose workers have no
/// credential of their own, would pin those workers to the desktop. While the
/// desktop is dispatch-ready they are not moved to a hosted runtime: none is
/// queued, the planning run fails with the reason, and the conversation says
/// why. The same plan authored on a hosted runtime queues its workers there,
/// and one authored on a desktop that has since stopped queues them unpinned,
/// for the hosted runtime.
#[tokio::test]
async fn plan_workers_pinned_to_a_private_runtime_fail_the_planning_run() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted plan worker test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "self-hosted-plan-workers").await?;
    let test_result: anyhow::Result<()> = async {
        let planner_credential_id = Uuid::new_v4();
        seed_custom_agent(
            &space.pool,
            &space.owner_user_id,
            &planner_credential_id,
            &Uuid::new_v4(),
            "planner",
            "Plans with its own key",
        )
        .await?;
        let config = space.config("self-hosted-plan-workers");
        let state = build_test_state(space.pool.clone(), config.clone());
        let plan_message = json!({
            "messageType": "multi_agent_plan",
            "details": {
                "mode": "read_only",
                "agents": [
                    { "handle": "scout-a", "prompt": "Read the README." },
                    { "handle": "scout-b", "prompt": "Read the docs folder." }
                ]
            }
        });
        let plan_text = "Two scouts will read the README and the docs.";
        let expected_reason = format!("The plan's agents could not start. {SELF_HOSTED_REFUSAL}");

        let (conversation_id, run_id, job_id, payload) = insert_leased_plan_job(
            &space,
            space.desktop_runtime_id,
            Some(planner_credential_id),
            json!({ "agent": { "handle": "planner" } }),
        )
        .await?;
        let mut events = state.events.subscribe();
        let handled = crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
            &state,
            &payload,
            job_id,
            Some(run_id),
            &plan_message,
            plan_text,
        )
        .await
        .map_err(|error| controller_error("refused plan", error))?;
        assert!(handled, "the plan message was handled");

        let connection = space.pool.get().await?;
        let jobs: i64 = connection
            .query_one(
                "select count(*)::bigint from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(jobs, 1, "no worker is queued");
        let job = connection
            .query_one(
                "select status, outcome, error_message from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(job.get::<_, String>("status"), "failed");
        assert_eq!(
            job.get::<_, Option<String>>("outcome").as_deref(),
            Some("failed")
        );
        assert_eq!(
            job.get::<_, Option<String>>("error_message").as_deref(),
            Some(expected_reason.as_str())
        );
        let run = connection
            .query_one(
                "select status, last_message from runs where id = $1",
                &[&run_id],
            )
            .await?;
        assert_eq!(run.get::<_, String>("status"), "failed");
        assert_eq!(
            run.get::<_, Option<String>>("last_message").as_deref(),
            Some(expected_reason.as_str())
        );
        let messages = connection
            .query(
                "select role, content, run_id, metadata from conversation_messages
                 where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(messages.len(), 1, "the conversation hears why");
        assert_eq!(messages[0].get::<_, String>("role"), "assistant");
        assert_eq!(messages[0].get::<_, String>("content"), expected_reason);
        assert_eq!(messages[0].get::<_, Option<Uuid>>("run_id"), Some(run_id));
        let metadata = messages[0]
            .get::<_, PgJson<serde_json::Value>>("metadata")
            .0;
        assert_eq!(metadata["kind"], SELF_HOSTED_REFUSAL_CODE);
        assert_eq!(metadata["messageType"], "error");
        assert_eq!(metadata["jobId"], json!(job_id.to_string()));
        // The plan's group, but no plan role: the Studio hides a "worker"
        // message, and with it the plan's announcement.
        assert!(
            metadata["multiAgentPlan"]["groupId"]
                .as_str()
                .is_some_and(|group_id| Uuid::parse_str(group_id).is_ok()),
            "{metadata}"
        );
        assert!(
            metadata["multiAgentPlan"].get("role").is_none(),
            "{metadata}"
        );
        drop(connection);
        let mut run_completed = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.run_id == Some(run_id) && event.kind == "run.completed" {
                run_completed.push(event.data);
            }
        }
        assert_eq!(run_completed.len(), 1, "{run_completed:?}");
        assert_eq!(run_completed[0]["outcome"], "failed");
        assert_eq!(run_completed[0]["errorMessage"], expected_reason);

        // The same plan authored on the hosted runtime queues its workers
        // there, credential-less.
        let (conversation_id, _, job_id, payload) = insert_leased_plan_job(
            &space,
            space.hosted_runtime_id,
            Some(planner_credential_id),
            json!({ "agent": { "handle": "planner" } }),
        )
        .await?;
        crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
            &state,
            &payload,
            job_id,
            None,
            &plan_message,
            plan_text,
        )
        .await
        .map_err(|error| controller_error("hosted plan", error))?;
        let connection = space.pool.get().await?;
        let workers = connection
            .query(
                "select target_runtime_id, credential_id from agent_jobs
                 where conversation_id = $1 and id <> $2",
                &[&conversation_id, &job_id],
            )
            .await?;
        assert_eq!(workers.len(), 2);
        for worker in workers {
            assert_eq!(
                worker.get::<_, Option<Uuid>>("target_runtime_id"),
                Some(space.hosted_runtime_id)
            );
            assert_eq!(worker.get::<_, Option<Uuid>>("credential_id"), None);
        }
        let parent_status: String = connection
            .query_one("select status from agent_jobs where id = $1", &[&job_id])
            .await?
            .get(0);
        assert_eq!(parent_status, "completed");
        drop(connection);

        // The same plan authored on the desktop, which has stopped since, is
        // not refused: its workers are unpinned from the desktop, as from any
        // runtime that is not dispatch-ready, and the hosted runtime runs them.
        stop_runtime(&space.pool, &space.desktop_runtime_id).await?;
        let (conversation_id, _, job_id, payload) = insert_leased_plan_job(
            &space,
            space.desktop_runtime_id,
            Some(planner_credential_id),
            json!({ "agent": { "handle": "planner" } }),
        )
        .await?;
        crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
            &state,
            &payload,
            job_id,
            None,
            &plan_message,
            plan_text,
        )
        .await
        .map_err(|error| controller_error("plan on the stopped desktop", error))?;
        let connection = space.pool.get().await?;
        let workers = connection
            .query(
                "select id, status, target_runtime_id, credential_id from agent_jobs
                 where conversation_id = $1 and id <> $2",
                &[&conversation_id, &job_id],
            )
            .await?;
        assert_eq!(workers.len(), 2);
        for worker in &workers {
            assert_eq!(worker.get::<_, String>("status"), "queued");
            assert_eq!(worker.get::<_, Option<Uuid>>("target_runtime_id"), None);
            assert_eq!(worker.get::<_, Option<Uuid>>("credential_id"), None);
        }
        let parent_status: String = connection
            .query_one("select status from agent_jobs where id = $1", &[&job_id])
            .await?
            .get(0);
        assert_eq!(parent_status, "completed");
        drop(connection);
        let app = agent::router().with_state(state.clone());
        let leased = lease_all_jobs(
            &app,
            &config,
            space.project_id,
            space.hosted_runtime_id,
            None,
        )
        .await?;
        for worker in &workers {
            let worker_id: Uuid = worker.get("id");
            assert!(
                leased.contains(&worker_id),
                "the hosted runtime runs worker {worker_id}, got {leased:?}"
            );
        }
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// Insert a finished worker of plan `group_id` whose runtime preference is
/// `runtime_id`, with `@octo` (no credential) as the plan's lead.
async fn insert_finished_plan_worker(
    space: &ManagedSpace,
    group_id: Uuid,
    runtime_id: Uuid,
) -> anyhow::Result<(Uuid, Uuid, serde_json::Value)> {
    let (conversation_id, run_id, job_id, _) = insert_leased_plan_job(
        space,
        runtime_id,
        None,
        json!({
            "agent": { "handle": "scout" },
            "runtimePreference": { "runtimeId": runtime_id },
            "multiAgentPlan": {
                "groupId": group_id,
                "role": "worker",
                "lead": { "leadHandle": "octo" }
            }
        }),
    )
    .await?;
    let connection = space.pool.get().await?;
    let payload = connection
        .query_one(
            "update agent_jobs
             set status = 'completed', outcome = 'succeeded', summary = 'Read it.',
                 completed_at = now()
             where id = $1
             returning payload",
            &[&job_id],
        )
        .await?
        .get::<_, PgJson<serde_json::Value>>(0)
        .0;
    connection
        .execute(
            "update runs set status = 'success' where id = $1",
            &[&run_id],
        )
        .await?;
    Ok((conversation_id, job_id, payload))
}

/// A lead checkpoint whose lead has no credential of its own would be pinned
/// to the desktop its workers ran on. It is not moved to a hosted runtime: no
/// lead job is queued and the conversation says why, once per plan however
/// often the checkpoint is tried. On a hosted runtime the lead is queued.
#[tokio::test]
async fn lead_checkpoint_pinned_to_a_private_runtime_is_written_to_the_conversation_once(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted lead checkpoint test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "self-hosted-lead-checkpoint").await?;
    let test_result: anyhow::Result<()> = async {
        let state = build_test_state(
            space.pool.clone(),
            space.config("self-hosted-lead-checkpoint"),
        );
        let group_id = Uuid::new_v4();
        let (conversation_id, worker_job_id, payload) =
            insert_finished_plan_worker(&space, group_id, space.desktop_runtime_id).await?;
        for attempt in 0..2 {
            let dispatched =
                crate::multi_agent_plan::maybe_enqueue_lead_continuation_after_completion(
                    &state,
                    worker_job_id,
                    &payload,
                )
                .await
                .map_err(|error| controller_error("refused lead checkpoint", error))?;
            assert!(!dispatched, "attempt {attempt} queued no lead");
        }

        let connection = space.pool.get().await?;
        let jobs: i64 = connection
            .query_one(
                "select count(*)::bigint from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(jobs, 1, "only the worker");
        let messages = connection
            .query(
                "select content, metadata from conversation_messages
                 where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(messages.len(), 1, "said once");
        assert_eq!(
            messages[0].get::<_, String>("content"),
            format!("@octo could not continue the plan. {SELF_HOSTED_REFUSAL}")
        );
        let metadata = messages[0]
            .get::<_, PgJson<serde_json::Value>>("metadata")
            .0;
        assert_eq!(metadata["kind"], SELF_HOSTED_REFUSAL_CODE);
        assert_eq!(metadata["messageType"], "error");
        assert_eq!(metadata["multiAgentPlan"]["role"], "lead_continuation");
        assert_eq!(
            metadata["multiAgentPlan"]["groupId"],
            json!(group_id.to_string())
        );
        drop(connection);

        let hosted_group_id = Uuid::new_v4();
        let (conversation_id, worker_job_id, payload) =
            insert_finished_plan_worker(&space, hosted_group_id, space.hosted_runtime_id).await?;
        let dispatched = crate::multi_agent_plan::maybe_enqueue_lead_continuation_after_completion(
            &state,
            worker_job_id,
            &payload,
        )
        .await
        .map_err(|error| controller_error("hosted lead checkpoint", error))?;
        assert!(dispatched);
        let lead_target: Option<Uuid> = space
            .pool
            .get()
            .await?
            .query_one(
                "select target_runtime_id from agent_jobs
                 where conversation_id = $1 and id <> $2",
                &[&conversation_id, &worker_job_id],
            )
            .await?
            .get(0);
        assert_eq!(lead_target, Some(space.hosted_runtime_id));
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// The plan-authoring message of a read-only plan with two credential-less
/// scouts, spread over runtimes when `spread` says so.
fn scout_plan_message(spread: bool) -> serde_json::Value {
    let mut details = json!({
        "mode": "read_only",
        "agents": [
            { "handle": "scout-a", "prompt": "Read the README." },
            { "handle": "scout-b", "prompt": "Read the docs folder." }
        ]
    });
    if spread {
        // One slot: the plan starts no extra runtime here.
        details["runtimeRouting"] = json!({ "strategy": "spread", "desiredSlots": 1 });
    }
    json!({ "messageType": "multi_agent_plan", "details": details })
}

/// Lease, as `runtime_id` of `project_id` and inside a transaction that is
/// rolled back, the next job of plan `group_id`, excluding platform AI jobs
/// when the runtime is private, as `/agent/lease` does.
async fn lease_plan_group_job(
    pool: &PgPool,
    project_id: Uuid,
    runtime_id: Uuid,
    runtime_is_private: bool,
    group_id: Uuid,
) -> anyhow::Result<Option<Uuid>> {
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let group_id = group_id.to_string();
    let leased = agent::lease_next_agent_job(
        &transaction,
        &project_id,
        Some(&runtime_id),
        60,
        true,
        false,
        false,
        false,
        None,
        Some(group_id.as_str()),
        runtime_is_private,
    )
    .await
    .map_err(|error| controller_error("lease a plan group job", error))?;
    transaction.rollback().await?;
    Ok(leased.map(|job| job.id))
}

/// A spread plan's workers are not pinned, but only the plan's parent runtime
/// or extra runtimes started for the plan on the parent's provider may take
/// them. Authored on a desktop, with workers that have no credential of their
/// own, the plan is refused like a pinned one: no worker is queued and the
/// planning run fails with the reason. The same plan authored on a
/// non-canonical managed runtime queues its workers unpinned, and that
/// runtime takes them.
#[tokio::test]
async fn spread_plan_workers_on_a_private_parent_fail_the_planning_run() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping self-hosted spread plan test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "self-hosted-spread-plan").await?;
    let test_result: anyhow::Result<()> = async {
        let planner_credential_id = Uuid::new_v4();
        seed_custom_agent(
            &space.pool,
            &space.owner_user_id,
            &planner_credential_id,
            &Uuid::new_v4(),
            "planner",
            "Plans with its own key",
        )
        .await?;
        let state = build_test_state(space.pool.clone(), space.config("self-hosted-spread-plan"));
        let plan_message = scout_plan_message(true);
        let plan_text = "Two scouts will read the README and the docs, side by side.";
        let expected_reason = format!("The plan's agents could not start. {SELF_HOSTED_REFUSAL}");

        let (conversation_id, run_id, job_id, payload) = insert_leased_plan_job(
            &space,
            space.desktop_runtime_id,
            Some(planner_credential_id),
            json!({ "agent": { "handle": "planner" } }),
        )
        .await?;
        let handled = crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
            &state,
            &payload,
            job_id,
            Some(run_id),
            &plan_message,
            plan_text,
        )
        .await
        .map_err(|error| controller_error("refused spread plan", error))?;
        assert!(handled, "the plan message was handled");

        let connection = space.pool.get().await?;
        let jobs: i64 = connection
            .query_one(
                "select count(*)::bigint from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(jobs, 1, "no worker is queued");
        let job = connection
            .query_one(
                "select status, error_message from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        assert_eq!(job.get::<_, String>("status"), "failed");
        assert_eq!(
            job.get::<_, Option<String>>("error_message").as_deref(),
            Some(expected_reason.as_str())
        );
        let run_status: String = connection
            .query_one("select status from runs where id = $1", &[&run_id])
            .await?
            .get(0);
        assert_eq!(run_status, "failed");
        let metadata = connection
            .query_one(
                "select metadata from conversation_messages
                 where conversation_id = $1 and role = 'assistant'",
                &[&conversation_id],
            )
            .await?
            .get::<_, PgJson<serde_json::Value>>(0)
            .0;
        assert_eq!(metadata["kind"], SELF_HOSTED_REFUSAL_CODE);
        drop(connection);

        let (conversation_id, _, job_id, payload) = insert_leased_plan_job(
            &space,
            space.acme_runtime_id,
            Some(planner_credential_id),
            json!({ "agent": { "handle": "planner" } }),
        )
        .await?;
        crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
            &state,
            &payload,
            job_id,
            None,
            &plan_message,
            plan_text,
        )
        .await
        .map_err(|error| controller_error("spread plan on acme-cloud", error))?;
        let connection = space.pool.get().await?;
        let workers = connection
            .query(
                "select id, target_runtime_id, credential_id, payload from agent_jobs
                 where conversation_id = $1 and id <> $2",
                &[&conversation_id, &job_id],
            )
            .await?;
        assert_eq!(workers.len(), 2);
        let mut group_id = None;
        for worker in &workers {
            assert_eq!(worker.get::<_, Option<Uuid>>("target_runtime_id"), None);
            assert_eq!(worker.get::<_, Option<Uuid>>("credential_id"), None);
            let plan = &worker.get::<_, PgJson<serde_json::Value>>("payload").0["metadata"]
                ["multiAgentPlan"];
            assert_eq!(
                plan["parentRuntimeId"],
                json!(space.acme_runtime_id.to_string())
            );
            group_id = plan["groupId"]
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok());
        }
        let parent_status: String = connection
            .query_one("select status from agent_jobs where id = $1", &[&job_id])
            .await?
            .get(0);
        assert_eq!(parent_status, "completed");
        drop(connection);
        let leased = lease_plan_group_job(
            &space.pool,
            space.project_id,
            space.acme_runtime_id,
            false,
            group_id.expect("the workers carry their plan group"),
        )
        .await?;
        assert!(
            leased.is_some_and(|job_id| workers
                .iter()
                .any(|worker| worker.get::<_, Uuid>("id") == job_id)),
            "the plan's parent runtime takes a worker, got {leased:?}"
        );
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// A refused plan fails its planning turn, which then no longer holds the
/// conversation's lane: a message queued behind that turn is sent right away
/// rather than waiting for some later turn to finish.
#[tokio::test]
async fn refused_plan_sends_the_message_queued_behind_the_planning_turn() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping refused plan send queue test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool, "self-hosted-plan-send-queue").await?;
    let test_result: anyhow::Result<()> = async {
        let planner_credential_id = Uuid::new_v4();
        seed_custom_agent(
            &space.pool,
            &space.owner_user_id,
            &planner_credential_id,
            &Uuid::new_v4(),
            "planner",
            "Plans with its own key",
        )
        .await?;
        let state = build_test_state(
            space.pool.clone(),
            space.config("self-hosted-plan-send-queue"),
        );
        let (conversation_id, run_id, job_id, payload) = insert_leased_plan_job(
            &space,
            space.desktop_runtime_id,
            Some(planner_credential_id),
            json!({ "agent": { "handle": "planner" } }),
        )
        .await?;
        // The owner queued a follow-up to @planner while it was planning.
        let entry_id = Uuid::new_v4();
        space
            .pool
            .get()
            .await?
            .execute(
                "insert into conversation_send_queue (
                     id, project_id, conversation_id, user_id, status, request
                 ) values ($1, $2, $3, $4, 'queued', $5)",
                &[
                    &entry_id,
                    &space.project_id,
                    &conversation_id,
                    &space.owner_user_id,
                    &PgJson(json!({
                        "promptText": "Then summarize what the scouts found.",
                        "intent": "feature",
                        "metadata": {
                            "agentSelection": { "active": ["planner"], "mentions": [] }
                        },
                        "runtimeId": space.hosted_runtime_id.to_string(),
                    })),
                ],
            )
            .await?;

        crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
            &state,
            &payload,
            job_id,
            Some(run_id),
            &scout_plan_message(false),
            "Two scouts will read the README and the docs.",
        )
        .await
        .map_err(|error| controller_error("refused plan", error))?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let entry = loop {
            let entry = space
                .pool
                .get()
                .await?
                .query_one(
                    "select status, error_message, dispatched_run_id
                     from conversation_send_queue where id = $1",
                    &[&entry_id],
                )
                .await?;
            if entry.get::<_, String>("status") == "failed"
                || entry.get::<_, Option<Uuid>>("dispatched_run_id").is_some()
            {
                break entry;
            }
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "the queued message was not sent after the refusal (status {})",
                entry.get::<_, String>("status")
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        assert_eq!(
            entry.get::<_, String>("status"),
            "dispatched",
            "{:?}",
            entry.get::<_, Option<String>>("error_message")
        );
        let dispatched_run_id = entry
            .get::<_, Option<Uuid>>("dispatched_run_id")
            .expect("the sent message has a run");
        let job = space
            .pool
            .get()
            .await?
            .query_one(
                "select target_runtime_id, credential_id from agent_jobs where run_id = $1",
                &[&dispatched_run_id],
            )
            .await?;
        assert_eq!(
            job.get::<_, Option<Uuid>>("target_runtime_id"),
            Some(space.hosted_runtime_id)
        );
        assert_eq!(
            job.get::<_, Option<Uuid>>("credential_id"),
            Some(planner_credential_id)
        );
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    test_result?;
    cleanup
}

/// Queue a credential-less spread worker of plan `group_id` whose plan's
/// parent runtime is `parent_runtime_id`.
async fn insert_spread_plan_worker(
    fixture: &LeaseFixture,
    group_id: Option<Uuid>,
    parent_runtime_id: Uuid,
) -> anyhow::Result<Uuid> {
    let job_id = Uuid::new_v4();
    fixture
        .pool
        .get()
        .await?
        .execute(
            "insert into agent_jobs (id, project_id, status, intent, payload)
             values ($1, $2, 'queued', 'multi_agent_plan', $3)",
            &[
                &job_id,
                &fixture.project_id,
                &PgJson(json!({
                    "user_id": fixture.owner_user_id,
                    "prompt_text": "Read the docs folder.",
                    "metadata": {
                        "runtimeRouting": {
                            "strategy": "spread",
                            "allowUntargetedAcrossPreferredRuntimes": true
                        },
                        "multiAgentPlan": {
                            "groupId": group_id,
                            "role": "worker",
                            "parentRuntimeId": parent_runtime_id
                        }
                    }
                })),
            ],
        )
        .await?;
    Ok(job_id)
}

/// Give `runtime_id` an active lease started for plan `group_id`, as the
/// extra runtimes of a spread plan get.
async fn lease_runtime_for_plan_group(
    fixture: &LeaseFixture,
    runtime_id: Uuid,
    group_id: Uuid,
) -> anyhow::Result<()> {
    let lease_id = Uuid::new_v4();
    let connection = fixture.pool.get().await?;
    connection
        .execute(
            "insert into runtime_leases (
                 id, project_id, runtime_id, status, requested_at, launched_at, metadata
             ) values ($1, $2, $3, 'active', now(), now(), $4)",
            &[
                &lease_id,
                &fixture.project_id,
                &runtime_id,
                &PgJson(json!({ "groupId": group_id, "source": "skill_multi_agent_plan" })),
            ],
        )
        .await?;
    connection
        .execute(
            "update runtimes set active_lease_id = $2 where id = $1",
            &[&runtime_id, &lease_id],
        )
        .await?;
    Ok(())
}

/// A spread worker of a plan that is already queued (before dispatch refused
/// such plans, or by any path around it) with a desktop parent and a
/// self-hosted extra runtime can never start: no runtime of the space leases
/// it. The controller's idle sweep fails it with the dispatch refusal's
/// reason. It leaves alone a spread worker that a hosted runtime leased for
/// its plan, or its hosted parent, takes, and a spread job of no plan.
#[tokio::test]
async fn spread_plan_worker_with_only_private_runtimes_is_failed_by_the_idle_sweep(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping spread plan worker sweep test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let fixture = LeaseFixture::new(pool, "spread-private-plan-sweep").await?;
    let test_result: anyhow::Result<()> = async {
        let desktop = fixture.desktop_runtime_id;
        let desktop_slot = Uuid::new_v4();
        insert_private_runtime(
            &fixture.pool,
            &fixture.project_id,
            &desktop_slot,
            &fixture.owner_user_id,
            &Uuid::new_v4(),
        )
        .await?;
        let hosted = Uuid::new_v4();
        let hosted_slot = Uuid::new_v4();
        for runtime_id in [hosted, hosted_slot] {
            insert_ready_runtime(
                &fixture.pool,
                &fixture.project_id,
                &runtime_id,
                "instafy-cloud",
                json!({ "agent": true, "origin": true }),
            )
            .await?;
        }
        let stranded_group = Uuid::new_v4();
        let hosted_slot_group = Uuid::new_v4();
        let hosted_parent_group = Uuid::new_v4();
        lease_runtime_for_plan_group(&fixture, desktop_slot, stranded_group).await?;
        lease_runtime_for_plan_group(&fixture, hosted_slot, hosted_slot_group).await?;
        let stranded = insert_spread_plan_worker(&fixture, Some(stranded_group), desktop).await?;
        let hosted_slot_worker =
            insert_spread_plan_worker(&fixture, Some(hosted_slot_group), desktop).await?;
        let hosted_parent_worker =
            insert_spread_plan_worker(&fixture, Some(hosted_parent_group), hosted).await?;
        let ungrouped = insert_spread_plan_worker(&fixture, None, desktop).await?;

        for (runtime_id, runtime_is_private) in [
            (desktop, true),
            (desktop_slot, true),
            (hosted, false),
            (hosted_slot, false),
        ] {
            assert_eq!(
                lease_plan_group_job(
                    &fixture.pool,
                    fixture.project_id,
                    runtime_id,
                    runtime_is_private,
                    stranded_group,
                )
                .await?,
                None,
                "runtime {runtime_id} leased the stranded worker"
            );
        }

        age_past_the_stranded_job_grace(
            &fixture.pool,
            &[
                stranded,
                hosted_slot_worker,
                hosted_parent_worker,
                ungrouped,
            ],
        )
        .await?;
        let state = build_test_state(fixture.pool.clone(), fixture.config.clone());
        runtime::sweep_idle_activity(&state).await?;

        assert_eq!(
            fixture.job_status(&stranded).await?,
            ("failed".to_string(), 0)
        );
        let error_message: Option<String> = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select error_message from agent_jobs where id = $1",
                &[&stranded],
            )
            .await?
            .get(0);
        assert_eq!(error_message.as_deref(), Some(SELF_HOSTED_REFUSAL));
        for job_id in [hosted_slot_worker, hosted_parent_worker, ungrouped] {
            assert_eq!(
                fixture.job_status(&job_id).await?,
                ("queued".to_string(), 0),
                "job {job_id} has a runtime to run on"
            );
        }
        assert_eq!(
            lease_plan_group_job(
                &fixture.pool,
                fixture.project_id,
                hosted_slot,
                false,
                hosted_slot_group,
            )
            .await?,
            Some(hosted_slot_worker)
        );
        assert_eq!(
            lease_plan_group_job(
                &fixture.pool,
                fixture.project_id,
                hosted,
                false,
                hosted_parent_group,
            )
            .await?,
            Some(hosted_parent_worker)
        );
        Ok(())
    }
    .await;
    let cleanup = fixture.cleanup().await;
    test_result?;
    cleanup
}
