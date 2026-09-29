//! The platform job record, the job token's binding and its verification, on
//! the migrated database.
//!
//! Dispatch writes one `ai_usage_jobs` row per credential-less AI job, the job
//! lease records the sha256 of every job token it mints under its lease
//! attempt, and `verify_proxy_job_token` accepts only a token recorded that
//! way. Nothing here bills: every record is `record_only`.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use chrono::Utc;
use httpmock::Method::GET;
use httpmock::MockServer;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::ai_metering::job_record::bind_job_token;
use crate::auth::{
    issue_proxy_envelope, proxy_token_sha256, verify_proxy_job_token, ProxyJobBinding,
    ProxyJobTokenMode, ProxyJobTokenRejection, RequestContext, VerifiedProxyJobToken,
    MANAGED_AI_SETTLE_MAX_AGE_SECONDS,
};
use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::dispatch::{self, DispatchPromptNormalized, DispatchPromptRequest};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::{agent, AppState};

const JOB_TOKEN_SECRET: &str = "platform-job-record-test-secret";
/// The hosted provider the lease tests run on. A platform job never runs on a
/// desktop or self-hosted runtime, so those tests use a hosted one.
const HOSTED_PROVIDER: &str = "instafy-cloud";

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

fn test_config(label: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.proxy_signing_secret = Some(JOB_TOKEN_SECRET.to_string());
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: HOSTED_PROVIDER.to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    config
}

/// An org with an owner, a builder and one project, holding a few credits
/// for the legacy reserve a managed prompt still burns.
struct Team {
    org_id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    builder_user_id: Uuid,
}

impl Team {
    fn new() -> Self {
        Self {
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            builder_user_id: Uuid::new_v4(),
        }
    }

    fn fixture(&self) -> SharedDbFixture {
        SharedDbFixture {
            organizations: vec![self.org_id],
            projects: vec![self.project_id],
        }
    }

    async fn seed(&self, pool: &PgPool, label: &str) -> anyhow::Result<()> {
        ensure_test_user(pool, &self.owner_user_id).await?;
        ensure_test_user(pool, &self.builder_user_id).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&self.org_id, &format!("{label}-{}", self.org_id), &label],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder')",
                &[&self.org_id, &self.owner_user_id, &self.builder_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, $3, $4, 'customer', 'active')",
                &[&self.project_id, &self.org_id, &label, &self.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&self.project_id, &self.builder_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&self.org_id, &self.project_id],
            )
            .await?;
        Ok(())
    }

    /// The owner's default BYO credential: from here on every dispatch for
    /// the owner resolves to it.
    async fn add_owner_default_credential(&self, pool: &PgPool) -> anyhow::Result<Uuid> {
        let credential_id = Uuid::new_v4();
        pool.get()
            .await?
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                 ) values ($1, $2, 'openai_api_key', 'Platform job record test',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, true)",
                &[&credential_id, &self.owner_user_id],
            )
            .await?;
        Ok(credential_id)
    }

    /// A custom agent of the owner with its own BYO credential.
    async fn add_owner_byo_agent(&self, pool: &PgPool, handle: &str) -> anyhow::Result<Uuid> {
        let credential_id = Uuid::new_v4();
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                 ) values ($1, $2, 'openai_api_key', 'Custom agent credential',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, false)",
                &[&credential_id, &self.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into user_agents (
                     id, user_id, credential_id, provider, handle, display_name,
                     description, avatar_seed
                 ) values ($1, $2, $3, 'openai', $4, initcap($4), 'Reviews designs', $4)",
                &[
                    &Uuid::new_v4(),
                    &self.owner_user_id,
                    &credential_id,
                    &handle,
                ],
            )
            .await?;
        Ok(credential_id)
    }

    /// A hosted runtime in the project, ready to lease.
    async fn add_hosted_runtime(&self, pool: &PgPool) -> anyhow::Result<Uuid> {
        let runtime_id = Uuid::new_v4();
        pool.get()
            .await?
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) values (
                     $1, $2, $3, 'ready', 'http://runtime.invalid',
                     $4, 600, now(), $5
                 )",
                &[
                    &runtime_id,
                    &self.project_id,
                    &HOSTED_PROVIDER,
                    &format!("platform-job-record-{runtime_id}"),
                    &PgJson(json!({ "agent": true, "origin": true })),
                ],
            )
            .await?;
        Ok(runtime_id)
    }
}

/// Runs a test body on a seeded team, then deletes the team and its users
/// however the body ends.
async fn with_team<F, Fut>(label: &str, body: F) -> anyhow::Result<()>
where
    F: FnOnce(PgPool, Team) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let pool = require_origin_test_pool(label).await?;
    let team = Team::new();
    let fixture = team.fixture();
    let users = vec![team.owner_user_id, team.builder_user_id];
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async move {
        team.seed(&body_pool, label).await?;
        body(body_pool, team).await
    })
    .await;
    let user_cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = any($1)", &[&users])
        .await;
    result.and(user_cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

fn user_context(user_id: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(user_id),
        is_service_role: false,
        scoped_claims: None,
    }
}

fn service_role_context(user_id: Option<Uuid>) -> RequestContext {
    RequestContext {
        user_id,
        is_service_role: true,
        scoped_claims: None,
    }
}

/// A dispatch into a new conversation. `mentions` are explicit `@handle`
/// mentions; without any, `active` agents answer.
fn dispatch_request(
    team: &Team,
    conversation_id: &Uuid,
    prompt: &str,
    intent: &str,
    active: &[&str],
    mentions: &[&str],
    visibility: &str,
) -> anyhow::Result<DispatchPromptNormalized> {
    dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(team.project_id.to_string()),
        session_id: None,
        prompt_text: Some(prompt.to_string()),
        intent: Some(intent.to_string()),
        plan_seed: None,
        metadata: Some(json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": active, "mentions": mentions }
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
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|error| controller_error("normalize dispatch", error))
}

async fn dispatch_as(
    state: &AppState,
    context: &RequestContext,
    request: DispatchPromptNormalized,
    case: &str,
) -> anyhow::Result<()> {
    let response = dispatch::process_dispatch_prompt(state, context, request)
        .await
        .map_err(|error| controller_error(case, error))?;
    anyhow::ensure!(
        response.status == "queued",
        "{case}: dispatch returned {}",
        response.status
    );
    Ok(())
}

/// A proxy whose `/healthz` reports static credentials, so the normal
/// managed lane admits a user's credential-less prompt.
async fn managed_proxy() -> MockServer {
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(GET).path("/healthz");
            then.status(200)
                .json_body(json!({ "backend": "codex", "requiresCredential": false }));
        })
        .await;
    server
}

/// A dispatched job and its platform record, if it has one.
#[derive(Debug)]
struct DispatchedJob {
    job_id: Uuid,
    handle: String,
    credential_id: Option<Uuid>,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    payload: JsonValue,
    record: Option<PlatformRecord>,
}

#[derive(Debug, PartialEq)]
struct PlatformRecord {
    org_id: Uuid,
    project_id: Uuid,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    billing_mode: String,
    decline_waiver_units: i32,
    answered: bool,
    token_sha256_by_attempt: JsonValue,
}

impl PlatformRecord {
    /// What dispatch must stamp on `job`'s record.
    fn expected(team: &Team, job: &DispatchedJob, decline_waiver_units: i32) -> Self {
        Self {
            org_id: team.org_id,
            project_id: team.project_id,
            run_id: job.run_id,
            prompt_id: job.prompt_id,
            billing_mode: "record_only".to_string(),
            decline_waiver_units,
            answered: false,
            token_sha256_by_attempt: json!({}),
        }
    }
}

/// The conversation's jobs, ordered by agent handle.
async fn dispatched_jobs(
    pool: &PgPool,
    conversation_id: &Uuid,
) -> anyhow::Result<Vec<DispatchedJob>> {
    let rows = pool
        .get()
        .await?
        .query(
            "select j.id, j.credential_id, j.run_id, j.prompt_id, j.payload,
                    coalesce(j.payload #>> '{metadata,agent,handle}', '') as handle,
                    t.job_id as record_job_id, t.org_id, t.project_id as record_project_id,
                    t.run_id as record_run_id, t.prompt_id as record_prompt_id,
                    t.billing_mode, t.decline_waiver_units,
                    t.answered_at is not null as answered, t.token_sha256_by_attempt
             from agent_jobs j
             left join ai_usage_jobs t on t.job_id = j.id
             where j.conversation_id = $1
             order by handle",
            &[conversation_id],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| DispatchedJob {
            job_id: row.get("id"),
            handle: row.get("handle"),
            credential_id: row.get("credential_id"),
            run_id: row.get("run_id"),
            prompt_id: row.get("prompt_id"),
            payload: row.get::<_, PgJson<JsonValue>>("payload").0,
            record: row
                .get::<_, Option<Uuid>>("record_job_id")
                .map(|_| PlatformRecord {
                    org_id: row.get("org_id"),
                    project_id: row.get("record_project_id"),
                    run_id: row.get("record_run_id"),
                    prompt_id: row.get("record_prompt_id"),
                    billing_mode: row.get("billing_mode"),
                    decline_waiver_units: row.get("decline_waiver_units"),
                    answered: row.get("answered"),
                    token_sha256_by_attempt: row
                        .get::<_, PgJson<JsonValue>>("token_sha256_by_attempt")
                        .0,
                }),
        })
        .collect())
}

/// The one job a single-agent dispatch into `conversation_id` enqueued.
async fn only_job(pool: &PgPool, conversation_id: &Uuid) -> anyhow::Result<DispatchedJob> {
    let mut jobs = dispatched_jobs(pool, conversation_id).await?;
    anyhow::ensure!(jobs.len() == 1, "expected one job, got {jobs:?}");
    Ok(jobs.remove(0))
}

#[tokio::test]
async fn dispatch_creates_platform_job_record_for_credentialless_ai_jobs_only() -> anyhow::Result<()>
{
    with_team("platform job record dispatch", |pool, team| async move {
        team.add_owner_byo_agent(&pool, "reviewer").await?;
        let proxy = managed_proxy().await;
        let mut config = test_config("platform-job-record-dispatch");
        config.proxy_base_url = Some(proxy.base_url());
        let state = build_test_state(pool.clone(), config);
        let owner = user_context(team.owner_user_id);

        // A managed prompt: the one job runs on the platform key.
        let platform = Uuid::new_v4();
        let request = dispatch_request(
            &team,
            &platform,
            "Summarize the README.",
            "feature",
            &["octo"],
            &[],
            "private",
        )?;
        dispatch_as(&state, &owner, request, "managed prompt").await?;
        let job = only_job(&pool, &platform).await?;
        assert_eq!(job.credential_id, None);
        assert!(job.run_id.is_some() && job.prompt_id.is_some());
        assert_eq!(
            job.record,
            Some(PlatformRecord::expected(&team, &job, 0)),
            "a managed prompt's job is a platform job"
        );

        // A terminal command needs no AI, so it has no platform lane.
        let terminal = Uuid::new_v4();
        let request = dispatch_request(
            &team,
            &terminal,
            "ls -la",
            "terminal_command",
            &["octo"],
            &[],
            "private",
        )?;
        dispatch_as(&state, &owner, request, "terminal command").await?;
        let job = only_job(&pool, &terminal).await?;
        assert_eq!(job.credential_id, None);
        assert_eq!(job.record, None, "a terminal command has no platform lane");

        // Octo runs on the platform key, the custom agent on its own key.
        let mixed = Uuid::new_v4();
        let request = dispatch_request(
            &team,
            &mixed,
            "@octo @reviewer compare the two designs.",
            "feature",
            &["octo", "reviewer"],
            &["octo", "reviewer"],
            "private",
        )?;
        dispatch_as(&state, &owner, request, "mixed targets").await?;
        let jobs = dispatched_jobs(&pool, &mixed).await?;
        let handles: Vec<&str> = jobs.iter().map(|job| job.handle.as_str()).collect();
        assert_eq!(handles, ["octo", "reviewer"]);
        assert_eq!(jobs[0].credential_id, None);
        assert_eq!(
            jobs[0].record,
            Some(PlatformRecord::expected(&team, &jobs[0], 0))
        );
        assert!(jobs[1].credential_id.is_some());
        assert_eq!(jobs[1].record, None, "a BYO target gets no platform record");

        // With a default credential the owner's prompt is BYO.
        let credential_id = team.add_owner_default_credential(&pool).await?;
        let byo = Uuid::new_v4();
        let request = dispatch_request(
            &team,
            &byo,
            "Summarize the README.",
            "feature",
            &["octo"],
            &[],
            "private",
        )?;
        dispatch_as(&state, &owner, request, "BYO prompt").await?;
        let job = only_job(&pool, &byo).await?;
        assert_eq!(job.credential_id, Some(credential_id));
        assert_eq!(job.record, None, "a BYO job gets no platform record");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn service_role_dispatch_creates_platform_job_record() -> anyhow::Result<()> {
    with_team(
        "service-role platform job record",
        |pool, team| async move {
            // No proxy: a service-role dispatch skips the managed-AI gate and
            // burns no reserve, yet its credential-less job runs on the
            // platform key all the same.
            let state = build_test_state(pool.clone(), test_config("service-role-job-record"));

            for (case, context) in [
                ("queued send without a user", service_role_context(None)),
                (
                    "worker for a user without a credential",
                    service_role_context(Some(team.owner_user_id)),
                ),
            ] {
                let conversation_id = Uuid::new_v4();
                let request = dispatch_request(
                    &team,
                    &conversation_id,
                    "Continue the plan.",
                    "feature",
                    &["octo"],
                    &[],
                    "private",
                )?;
                dispatch_as(&state, &context, request, case).await?;
                let job = only_job(&pool, &conversation_id).await?;
                assert_eq!(job.credential_id, None, "{case}");
                assert_eq!(
                    job.record,
                    Some(PlatformRecord::expected(&team, &job, 0)),
                    "{case}"
                );
            }
            let reserves: i64 = pool
                .get()
                .await?
                .query_one(
                    "select count(*) from org_credit_ledger
                 where project_id = $1 and reason = 'managed_ai_prompt'",
                    &[&team.project_id],
                )
                .await?
                .get(0);
            assert_eq!(reserves, 0, "service-role dispatches burn no reserve");

            // A worker for a user with a default credential runs on that key.
            team.add_owner_default_credential(&pool).await?;
            let conversation_id = Uuid::new_v4();
            let request = dispatch_request(
                &team,
                &conversation_id,
                "Continue the plan.",
                "feature",
                &["octo"],
                &[],
                "private",
            )?;
            dispatch_as(
                &state,
                &service_role_context(Some(team.owner_user_id)),
                request,
                "worker for a BYO user",
            )
            .await?;
            let job = only_job(&pool, &conversation_id).await?;
            assert!(job.credential_id.is_some());
            assert_eq!(job.record, None);
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn ambient_evaluation_record_carries_waiver_and_automation_does_not() -> anyhow::Result<()> {
    with_team("ambient evaluation waiver", |pool, team| async move {
        team.add_owner_byo_agent(&pool, "reviewer").await?;
        let proxy = managed_proxy().await;
        let mut config = test_config("ambient-evaluation-waiver");
        config.proxy_base_url = Some(proxy.base_url());
        // Not the default, so the record provably takes the configured value.
        config.managed_ai_decline_waiver_units = 3;
        let state = build_test_state(pool.clone(), config);
        let owner = user_context(team.owner_user_id);

        // An ambient turn between two humans dispatches evaluations that may
        // decline. Only the platform one gets a record, with the waiver.
        let ambient = Uuid::new_v4();
        let request = dispatch_request(
            &team,
            &ambient,
            "Should we keep the blue version?",
            "feature",
            &["octo", "reviewer"],
            &[],
            "public",
        )?;
        dispatch_as(&state, &owner, request, "ambient evaluation").await?;
        let jobs = dispatched_jobs(&pool, &ambient).await?;
        assert_eq!(jobs.len(), 2, "{jobs:?}");
        for job in &jobs {
            assert!(
                crate::group_participation::metadata_marks_skill_mode_ambient_evaluation(
                    &job.payload["metadata"]
                ),
                "{} must be an ambient evaluation",
                job.handle
            );
        }
        assert_eq!(jobs[0].handle, "octo");
        assert_eq!(
            jobs[0].record,
            Some(PlatformRecord::expected(&team, &jobs[0], 3))
        );
        assert_eq!(jobs[1].handle, "reviewer");
        assert_eq!(jobs[1].record, None);

        // A scheduled automation may decline too, but it is an ordinary
        // billed run: no waiver.
        let automation = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into conversations (id, project_id, created_by, metadata, visibility, thread_kind)
                     values ($1, $2, $3, '{}'::jsonb, 'private', 'automation')",
                    &[&automation, &team.project_id, &team.owner_user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into conversation_participants (conversation_id, user_id, role, added_by)
                     values ($1, $2, 'owner', $2)",
                    &[&automation, &team.owner_user_id],
                )
                .await?;
        }
        let mut request = dispatch_request(
            &team,
            &automation,
            "Report anything new in the inbox.",
            "feature",
            &["octo"],
            &[],
            "private",
        )?;
        request.thread_kind = Some("automation".to_string());
        request.allow_silent_automation_decline = true;
        dispatch_as(&state, &owner, request, "automation").await?;
        let job = only_job(&pool, &automation).await?;
        assert!(
            crate::group_participation::metadata_marks_agent_evaluation(&job.payload["metadata"]),
            "the automation job may decline"
        );
        assert_eq!(job.record, Some(PlatformRecord::expected(&team, &job, 0)));

        // A client cannot claim the waiver through the payload: a direct
        // prompt carrying a forged evaluation marker gets none.
        let forged = Uuid::new_v4();
        let mut request = dispatch_request(
            &team,
            &forged,
            "Summarize the README.",
            "feature",
            &["octo"],
            &[],
            "private",
        )?;
        let metadata = request.metadata.as_object_mut().expect("metadata object");
        metadata.insert(
            "groupParticipation".to_string(),
            json!({
                "decision": "agent_evaluation",
                "reason": crate::group_participation::SKILL_MODE_AMBIENT_REASON,
                "enforcedBy": "runtime-controller",
            }),
        );
        metadata.insert("managedAiBillingDeferred".to_string(), json!(true));
        dispatch_as(&state, &owner, request, "forged evaluation marker").await?;
        let job = only_job(&pool, &forged).await?;
        assert_eq!(
            job.payload["metadata"]["managedAiBillingDeferred"],
            json!(true),
            "the forged flag reaches the payload, so the waiver must not read it"
        );
        assert_eq!(job.record, Some(PlatformRecord::expected(&team, &job, 0)));
        Ok(())
    })
    .await
}

/// A service-role dispatch for the owner, targeted at `runtime_id`: one job,
/// on the platform key unless the owner has a default credential.
async fn dispatch_to_runtime(
    state: &AppState,
    team: &Team,
    runtime_id: &Uuid,
) -> anyhow::Result<Uuid> {
    let conversation_id = Uuid::new_v4();
    let mut request = dispatch_request(
        team,
        &conversation_id,
        "Continue the plan.",
        "feature",
        &["octo"],
        &[],
        "private",
    )?;
    request.runtime_id = Some(*runtime_id);
    dispatch_as(
        state,
        &service_role_context(Some(team.owner_user_id)),
        request,
        "dispatch to runtime",
    )
    .await?;
    Ok(only_job(&state.pool, &conversation_id).await?.job_id)
}

/// Leases one job as the runtime and returns it with its proxy token.
async fn lease_one(
    state: &AppState,
    team: &Team,
    runtime_id: &Uuid,
) -> anyhow::Result<(Uuid, String)> {
    let agent_token =
        crate::auth::issue_agent_token(&state.config, &team.project_id, runtime_id, None, None)
            .map_err(|error| controller_error("issue agent token", error))?
            .token;
    let response = agent::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/lease")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {agent_token}"),
                )
                .body(Body::from(
                    json!({ "max": 1, "lease_seconds": 120 }).to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let body: JsonValue =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    anyhow::ensure!(status == StatusCode::OK, "lease returned {status}: {body}");
    let job = &body["jobs"][0];
    let job_id = Uuid::parse_str(job["id"].as_str().unwrap_or_default())?;
    let token = job["proxy"]["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("leased job has no proxy token: {body}"))?
        .to_string();
    Ok((job_id, token))
}

/// Puts a leased job back in the queue the way a requeue does, keeping its
/// lease attempts.
async fn requeue(pool: &PgPool, job_id: &Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update agent_jobs
             set status = 'queued', leased_at = null, lease_expires_at = null,
                 leased_by_runtime_id = null
             where id = $1",
            &[job_id],
        )
        .await?;
    Ok(())
}

async fn recorded_hashes(pool: &PgPool, job_id: &Uuid) -> anyhow::Result<Option<JsonValue>> {
    Ok(pool
        .get()
        .await?
        .query_opt(
            "select token_sha256_by_attempt from ai_usage_jobs where job_id = $1",
            &[job_id],
        )
        .await?
        .map(|row| row.get::<_, PgJson<JsonValue>>(0).0))
}

/// The claims of a controller-signed proxy token.
fn claims_of(token: &str) -> anyhow::Result<JsonValue> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&["proxy"]);
    validation.validate_exp = false;
    Ok(decode::<JsonValue>(
        token,
        &DecodingKey::from_secret(JOB_TOKEN_SECRET.as_bytes()),
        &validation,
    )?
    .claims)
}

fn sign(claims: &JsonValue, secret: &str) -> String {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("sign test proxy token")
}

async fn verify(
    state: &AppState,
    token: &str,
    mode: ProxyJobTokenMode,
) -> anyhow::Result<Result<VerifiedProxyJobToken, ProxyJobTokenRejection>> {
    let connection = state.pool.get().await?;
    verify_proxy_job_token(&*connection, &state.config, token, mode)
        .await
        .map_err(|error| controller_error("verify job token", error))
}

#[tokio::test]
async fn agent_lease_records_token_hash_per_attempt() -> anyhow::Result<()> {
    with_team("job token binding", |pool, team| async move {
        let runtime_id = team.add_hosted_runtime(&pool).await?;
        let state = build_test_state(pool.clone(), test_config("job-token-binding"));
        let platform_job = dispatch_to_runtime(&state, &team, &runtime_id).await?;
        let credential_id = team.add_owner_default_credential(&pool).await?;
        let byo_job = dispatch_to_runtime(&state, &team, &runtime_id).await?;
        assert_eq!(
            recorded_hashes(&pool, &platform_job).await?,
            Some(json!({}))
        );
        assert_eq!(recorded_hashes(&pool, &byo_job).await?, None);

        let (leased, first_token) = lease_one(&state, &team, &runtime_id).await?;
        assert_eq!(leased, platform_job);
        let claims = claims_of(&first_token)?;
        assert_eq!(claims["job_id"], json!(platform_job.to_string()));
        assert_eq!(claims["lease_attempt"], json!(1));
        assert!(claims.get("credential_id").is_none());
        assert_eq!(
            recorded_hashes(&pool, &platform_job).await?,
            Some(json!({ "1": proxy_token_sha256(&first_token) }))
        );

        // A BYO job's token names its attempt too, but it has no record to
        // bind it to.
        let (leased, byo_token) = lease_one(&state, &team, &runtime_id).await?;
        assert_eq!(leased, byo_job);
        let claims = claims_of(&byo_token)?;
        assert_eq!(claims["job_id"], json!(byo_job.to_string()));
        assert_eq!(claims["lease_attempt"], json!(1));
        assert_eq!(claims["credential_id"], json!(credential_id.to_string()));
        assert_eq!(recorded_hashes(&pool, &byo_job).await?, None);

        // A re-lease is a new attempt with its own token and hash; the first
        // attempt's hash stays, so its late settles still bill.
        requeue(&pool, &platform_job).await?;
        let (leased, second_token) = lease_one(&state, &team, &runtime_id).await?;
        assert_eq!(leased, platform_job);
        assert_ne!(second_token, first_token);
        assert_eq!(claims_of(&second_token)?["lease_attempt"], json!(2));
        assert_eq!(
            recorded_hashes(&pool, &platform_job).await?,
            Some(json!({
                "1": proxy_token_sha256(&first_token),
                "2": proxy_token_sha256(&second_token),
            }))
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn verify_proxy_job_token_rejects_forged_expired_wrong_audience_and_unbound(
) -> anyhow::Result<()> {
    use ProxyJobTokenMode::{Live, Settle};
    use ProxyJobTokenRejection::{Invalid, Unbound};

    with_team("job token verification", |pool, team| async move {
        let runtime_id = team.add_hosted_runtime(&pool).await?;
        let state = build_test_state(pool.clone(), test_config("job-token-verification"));
        let platform_job = dispatch_to_runtime(&state, &team, &runtime_id).await?;
        team.add_owner_default_credential(&pool).await?;
        let byo_job = dispatch_to_runtime(&state, &team, &runtime_id).await?;
        let (_, token) = lease_one(&state, &team, &runtime_id).await?;
        let (leased, byo_token) = lease_one(&state, &team, &runtime_id).await?;
        assert_eq!(leased, byo_job);

        let run_id = only_job_run(&pool, &platform_job).await?;
        assert_eq!(
            verify(&state, &token, Live).await?,
            Ok(VerifiedProxyJobToken {
                project_id: team.project_id,
                runtime_id,
                run_id,
                credential_id: None,
                job_id: platform_job,
                lease_attempt: 1,
                token_sha256: proxy_token_sha256(&token),
            })
        );

        let claims = claims_of(&token)?;
        let with = |key: &str, value: JsonValue| {
            let mut changed = claims.clone();
            changed[key] = value;
            changed
        };
        let without = |key: &str| {
            let mut changed = claims.clone();
            changed.as_object_mut().expect("claims object").remove(key);
            changed
        };
        for (case, forged) in [
            (
                "another signing secret",
                sign(&claims, "not-the-proxy-secret"),
            ),
            (
                "wrong audience",
                sign(&with("aud", json!("controller")), JOB_TOKEN_SECRET),
            ),
            (
                "wrong issuer",
                sign(&with("iss", json!("proxy")), JOB_TOKEN_SECRET),
            ),
            (
                "expired past the leeway",
                sign(
                    &with("exp", json!(Utc::now().timestamp() - 120)),
                    JOB_TOKEN_SECRET,
                ),
            ),
            ("no job id", sign(&without("job_id"), JOB_TOKEN_SECRET)),
            (
                "no lease attempt",
                sign(&without("lease_attempt"), JOB_TOKEN_SECRET),
            ),
            ("no issue time", sign(&without("iat"), JOB_TOKEN_SECRET)),
            ("not a JWT", "not-a-token".to_string()),
        ] {
            assert_eq!(verify(&state, &forged, Live).await?, Err(Invalid), "{case}");
        }

        // Signed with the real secret for the right job and attempt, but not
        // the token the lease minted.
        let reminted = sign(&with("agent_handle", json!("mallory")), JOB_TOKEN_SECRET);
        assert_eq!(verify(&state, &reminted, Live).await?, Err(Unbound));
        assert_eq!(verify(&state, &reminted, Settle).await?, Err(Unbound));
        // A BYO job has no record, so nothing binds its token.
        assert_eq!(verify(&state, &byo_token, Live).await?, Err(Unbound));
        assert_eq!(verify(&state, &byo_token, Settle).await?, Err(Unbound));

        // A re-lease replaces the live token.
        requeue(&pool, &platform_job).await?;
        let (_, second_token) = lease_one(&state, &team, &runtime_id).await?;
        assert_eq!(verify(&state, &token, Live).await?, Err(Unbound));
        assert!(verify(&state, &second_token, Live).await?.is_ok());

        // Expiry holds even for a token the lease bound.
        let mut expired_config = state.config.clone();
        expired_config.proxy_token_ttl_seconds = -120;
        let expired = issue_proxy_envelope(
            &expired_config,
            &team.project_id,
            &runtime_id,
            run_id.as_ref(),
            None,
            Some(ProxyJobBinding {
                job_id: platform_job,
                lease_attempt: 2,
            }),
            None,
            None,
            None,
        )
        .expect("expired envelope")
        .token;
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        bind_job_token(&transaction, &platform_job, 2, &expired)
            .await
            .map_err(|error| controller_error("bind expired token", error))?;
        transaction.commit().await?;
        assert_eq!(verify(&state, &expired, Live).await?, Err(Invalid));
        Ok(())
    })
    .await
}

async fn only_job_run(pool: &PgPool, job_id: &Uuid) -> anyhow::Result<Option<Uuid>> {
    Ok(pool
        .get()
        .await?
        .query_one("select run_id from agent_jobs where id = $1", &[job_id])
        .await?
        .get(0))
}

#[tokio::test]
async fn settle_mode_accepts_expired_token_within_max_age_for_its_own_attempt() -> anyhow::Result<()>
{
    use ProxyJobTokenMode::{Live, Settle};
    use ProxyJobTokenRejection::{Invalid, Unbound};

    with_team("settle job token", |pool, team| async move {
        let runtime_id = team.add_hosted_runtime(&pool).await?;
        let config = test_config("settle-job-token");
        let state = build_test_state(pool.clone(), config.clone());
        let platform_job = dispatch_to_runtime(&state, &team, &runtime_id).await?;

        // The first attempt's lease mints a token that has already expired,
        // as a queued settle's token has by the time it lands.
        let mut expiring_config = config.clone();
        expiring_config.proxy_token_ttl_seconds = -120;
        let expiring_state = build_test_state(pool.clone(), expiring_config);
        let (_, first_token) = lease_one(&expiring_state, &team, &runtime_id).await?;
        assert_eq!(verify(&state, &first_token, Live).await?, Err(Invalid));
        let settled = verify(&state, &first_token, Settle)
            .await?
            .expect("an expired token still settles");
        assert_eq!((settled.job_id, settled.lease_attempt), (platform_job, 1));

        // After a re-lease the first attempt's token still settles for its
        // own attempt, and the second attempt's token for its own.
        requeue(&pool, &platform_job).await?;
        let (_, second_token) = lease_one(&state, &team, &runtime_id).await?;
        let settled = verify(&state, &first_token, Settle)
            .await?
            .expect("a superseded attempt still settles");
        assert_eq!(settled.lease_attempt, 1);
        let settled = verify(&state, &second_token, Settle)
            .await?
            .expect("the current attempt settles");
        assert_eq!(settled.lease_attempt, 2);
        assert!(verify(&state, &second_token, Live).await?.is_ok());

        // Settle still needs the token the lease minted for that attempt.
        let mut claims = claims_of(&first_token)?;
        claims["agent_handle"] = json!("mallory");
        let reminted = sign(&claims, JOB_TOKEN_SECRET);
        assert_eq!(verify(&state, &reminted, Settle).await?, Err(Unbound));

        // And one issued within the settle max age: bound, but too old, it is
        // refused; bound and just young enough, it settles.
        let now = Utc::now().timestamp();
        for (issued_ago, expected_ok) in [
            (MANAGED_AI_SETTLE_MAX_AGE_SECONDS + 60, false),
            (MANAGED_AI_SETTLE_MAX_AGE_SECONDS - 60, true),
        ] {
            let mut claims = claims_of(&first_token)?;
            claims["iat"] = json!(now - issued_ago);
            claims["exp"] = json!(now - issued_ago + 1_800);
            let old_token = sign(&claims, JOB_TOKEN_SECRET);
            let mut connection = pool.get().await?;
            let transaction = connection.transaction().await?;
            bind_job_token(&transaction, &platform_job, 1, &old_token)
                .await
                .map_err(|error| controller_error("bind old token", error))?;
            transaction.commit().await?;
            let verdict = verify(&state, &old_token, Settle).await?;
            if expected_ok {
                assert_eq!(verdict.map(|token| token.lease_attempt), Ok(1));
            } else {
                assert_eq!(verdict, Err(Invalid), "issued {issued_ago}s ago");
            }
        }
        Ok(())
    })
    .await
}
