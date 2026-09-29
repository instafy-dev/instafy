//! Platform AI jobs (an AI job whose target has no credential) run only on
//! Instafy-hosted runtimes. A managed dispatch to a desktop or self-hosted
//! runtime is refused before any reserve, an ambient managed participant
//! there is skipped, and such a runtime never leases a platform job.

use super::*;

const SELF_HOSTED_REFUSAL: &str =
    "Instafy AI runs on Instafy-hosted runtimes. Connect your own AI to use this runtime.";

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
        .await
        .expect_err("a managed dispatch to a desktop runtime is refused");
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
        assert_eq!(refused.1 .0.message, SELF_HOSTED_REFUSAL);
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
        .await
        .expect_err("a managed agent pinned to a desktop runtime is refused");
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
        assert_eq!(refused.1 .0.message, SELF_HOSTED_REFUSAL);
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
        let config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
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
        let token = crate::auth::issue_agent_token(
            &self.config,
            &self.project_id,
            &runtime_id,
            None,
            generation,
        )
        .map_err(|error| controller_error("issue agent token", error))?
        .token;
        let mut leased = Vec::new();
        loop {
            let response = self
                .app
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
