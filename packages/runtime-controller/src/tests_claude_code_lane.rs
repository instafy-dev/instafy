#![cfg(test)]

// Local-engine turns on the migrated database, version 2
// (docs/Local-Engine-Turns.md section 11): Claude Code is an AI any agent can
// use. A Claude Code agent is its owner's `user_agents` row with the provider
// `claude-code` and no connection, and every turn its owner's dispatches give
// it, whoever or whatever started them, is checked before anything is
// written (`claude_code_lane::check_target`). An admitted turn's job waits,
// unpinned, until one of its person's own computers in the space with Claude
// Code ready leases it, one at a time for each person. The space and harness
// are `tests_provider_space.rs`'s, seeded here with a Claude Code agent,
// `@claude`, for the owner and the member, and with their lane-ready
// computers. Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use axum::http::StatusCode;
use axum::Json;
use axum::Router;
use chrono::{DateTime, Utc};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::claude_code_lane;
use crate::config::{
    AppConfig, ClaudeCodeLaneUsers, DeviceGrantUsers, PgPool, RuntimeProviderConfig,
};
use crate::dispatch::{DispatchPromptNormalized, DispatchPromptRequest};
use crate::job_trigger::JobTrigger;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, eventually, require_origin_test_pool,
    sql, sql_one, test_origin_private_key, test_origin_public_key, with_shared_db_fixture,
    SharedDbFixture,
};
use crate::tests_provider_space::{Harness, Space, SERVICE_ROLE};
use crate::{ApiError, AppState};

/// The words of every lane send here.
const WORDS: &str = "Fix the failing build in packages/app, then run its tests.";
/// The handle of the owner's and the member's own Claude Code agent.
const CLAUDE: &str = "claude";
const DEVICE_PROVIDER: &str = "device:lane-test";
const DEVICE: &str = "lane-device-1";

type Expected = (StatusCode, &'static str, &'static str);

/// L1's refusal: the switch does not cover the agent's owner.
fn not_allowed() -> Expected {
    (
        StatusCode::FORBIDDEN,
        claude_code_lane::TURN_NOT_ALLOWED,
        "not_allowed",
    )
}

/// L2's and L3's refusal of a turn Claude Code cannot take, with its reason.
fn unsupported(reason: &'static str) -> Expected {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        claude_code_lane::TURN_UNSUPPORTED,
        reason,
    )
}

/// `value` with `extra`'s keys set over its own.
fn with(mut value: JsonValue, extra: JsonValue) -> JsonValue {
    for (key, item) in extra.as_object().cloned().unwrap_or_default() {
        value[key] = item;
    }
    value
}

/// `value` without `keys`.
fn without(mut value: JsonValue, keys: &[&str]) -> JsonValue {
    if let Some(map) = value.as_object_mut() {
        for key in keys {
            map.remove(*key);
        }
    }
    value
}

/// A send's metadata as Studio sends it to the sender's own agents
/// `handles`, each mentioned, with `extra` over it.
fn metadata_for(handles: &[&str], extra: JsonValue) -> JsonValue {
    with(
        json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "agentSelection": { "active": handles, "mentions": handles },
            "input": { "kind": "person" },
            "writeIntent": true,
        }),
        extra,
    )
}

/// A send's metadata to the sender's own @claude, a Claude Code agent.
fn lane_metadata(extra: JsonValue) -> JsonValue {
    metadata_for(&[CLAUDE], extra)
}

/// A send of [`WORDS`] with `metadata`.
fn lane_send(metadata: JsonValue) -> JsonValue {
    json!({
        "promptText": WORDS,
        "intent": "feature",
        "metadata": metadata,
    })
}

/// An ordinary send to the sender's own @octo, which uses their default
/// connection, on `runtime`.
fn octo_send(runtime: Uuid) -> JsonValue {
    json!({
        "promptText": "Read the logs.",
        "intent": "feature",
        "runtimeId": runtime.to_string(),
        "metadata": metadata_for(&["octo"], json!({})),
    })
}

/// A computer's capabilities: an agent with an origin, attested to `owner`
/// when it has one, with `extra`.
fn capabilities(owner: Option<Uuid>, extra: JsonValue) -> JsonValue {
    let mut capabilities = json!({ "agent": true, "origin": true, "grantedTurns": true });
    if let Some(owner) = owner {
        crate::runtime::set_self_hosted_access_attestation(
            capabilities.as_object_mut().expect("capabilities"),
            owner,
        );
    }
    with(capabilities, extra)
}

/// The capability registration attests for a lane-ready computer.
fn lane_ready() -> JsonValue {
    json!({ "claudeCode": { "version": 1, "ready": true } })
}

/// The capability of a computer whose Claude Code is not ready.
fn lane_not_ready() -> JsonValue {
    json!({ "claudeCode": { "version": 1, "ready": false } })
}

fn person_context(user: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(user),
        is_service_role: false,
        scoped_claims: None,
    }
}

/// What a test can count of a space's writes: none may change on a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Written {
    prompts: i64,
    runs: i64,
    messages: i64,
    jobs: i64,
    platform_jobs: i64,
    ledger: i64,
    queued: i64,
    runtimes: i64,
}

/// One `agent_jobs` row as a test reads it.
#[derive(Debug)]
struct Job {
    engine: Option<String>,
    credential_id: Option<Uuid>,
    grant_ids: Option<Vec<Uuid>>,
    target_runtime_id: Option<Uuid>,
    trigger_received_at: Option<DateTime<Utc>>,
    parent_job_id: Option<Uuid>,
    plan_group_id: Option<Uuid>,
    agent_role: Option<String>,
    status: String,
    lease_attempts: i32,
    run_id: Option<Uuid>,
    payload: JsonValue,
}

/// A space whose owner and member are on the lane list and whose guest is not
/// (`tests_provider_space.rs`'s `Space`), each with a default AI connection;
/// the owner's and the member's own @claude, which uses Claude Code; and the
/// computers their lane turns run on.
struct Lane {
    harness: Harness,
    /// The owner's own lane-ready computers.
    desktop: Uuid,
    second_desktop: Uuid,
    /// The member's own lane-ready computer.
    member_desktop: Uuid,
    /// The owner's and the member's own @claude.
    owner_claude: Uuid,
    member_claude: Uuid,
    /// The owner's default AI connection.
    owner_credential: Uuid,
    service_user: Uuid,
}

/// Runs `body` on a fresh lane space whose config `configure` may change,
/// then deletes it and its people, however `body` ends, a failed assertion
/// included.
async fn with_lane<C, F, Fut>(label: &str, configure: C, body: F) -> anyhow::Result<()>
where
    C: FnOnce(&mut AppConfig, &Space),
    F: FnOnce(Lane) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let pool = require_origin_test_pool(label).await?;
    let space = Space {
        org_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        owner: Uuid::new_v4(),
        member: Uuid::new_v4(),
        guest: Uuid::new_v4(),
        owner_agent: Uuid::new_v4(),
        member_agent: Uuid::new_v4(),
        log: Uuid::new_v4(),
        other_chat: Uuid::new_v4(),
        runtime: Uuid::new_v4(),
        other_machine: Uuid::new_v4(),
    };
    let service_user = Uuid::new_v4();
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.claude_code_lane =
        ClaudeCodeLaneUsers(DeviceGrantUsers::Only(vec![space.owner, space.member]));
    config.service_runtime_user_id = Some(service_user);
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
    configure(&mut config, &space);
    let users = vec![space.owner, space.member, space.guest];
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let state = build_test_state(pool.clone(), config);
    let app = Router::new()
        .merge(crate::dispatch::router())
        .merge(crate::conversations::router())
        .merge(crate::send_queue::router())
        .merge(crate::send_intents::router())
        .merge(crate::agent::router())
        .merge(crate::ai_agents::router())
        .merge(crate::automations::router())
        .merge(crate::device_grants::router())
        .merge(crate::secrets::router())
        .merge(crate::runtime::router())
        .with_state(state.clone());
    let body_pool = pool.clone();
    let label = label.to_string();
    // The shared fixture deletes the space however its body ends, and then
    // goes on with a panic; the people go after it.
    let result = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(
        with_shared_db_fixture(fixture, async move {
            let lane = Lane::seed(body_pool, state, app, space, service_user, &label).await?;
            body(lane).await
        }),
    ))
    .await;
    let cleanup = async {
        pool.get()
            .await?
            .execute("delete from auth.users where id = any($1)", &[&users])
            .await?;
        anyhow::Ok(())
    }
    .await;
    match result {
        Ok(result) => result.and(cleanup),
        Err(panic) => {
            if let Err(error) = cleanup {
                eprintln!("[lane tests] could not delete the space's people: {error:#}");
            }
            std::panic::resume_unwind(panic)
        }
    }
}

impl Lane {
    async fn seed(
        pool: PgPool,
        state: AppState,
        app: Router,
        space: Space,
        service_user: Uuid,
        label: &str,
    ) -> anyhow::Result<Self> {
        for user in [space.owner, space.member, space.guest] {
            ensure_test_user(&pool, &user).await?;
        }
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&space.org_id, &format!("{label}-{}", space.org_id), &label],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($1, $3, 'builder')",
                &[&space.org_id, &space.owner, &space.member],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, $3, $4, 'customer', 'active')",
                &[&space.project_id, &space.org_id, &label, &space.owner],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder'), ($1, $3, 'builder')",
                &[&space.project_id, &space.member, &space.guest],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&space.org_id, &space.project_id],
            )
            .await?;
        let mut owner_credential = None;
        for (user, agent) in [
            (space.owner, space.owner_agent),
            (space.member, space.member_agent),
            (space.guest, Uuid::new_v4()),
        ] {
            let credential_id = Uuid::new_v4();
            connection
                .execute(
                    "insert into user_credentials (
                         id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                     ) values ($1, $2, 'openai_api_key', 'Lane test', 'test-nonce',
                         'test-ciphertext', '{}'::jsonb, true)",
                    &[&credential_id, &user],
                )
                .await?;
            connection
                .execute(
                    "insert into user_agents (
                         id, user_id, credential_id, provider, handle, display_name,
                         description, avatar_seed
                     ) values ($1, $2, $3, 'openai', 'helper', 'Helper', 'Helps', 'helper')",
                    &[&agent, &user, &credential_id],
                )
                .await?;
            if user == space.owner {
                owner_credential = Some(credential_id);
            }
        }
        // The owner's and the member's own @claude: Claude Code as its AI, so
        // no connection.
        let mut claude_agents = Vec::new();
        for user in [space.owner, space.member] {
            let agent = Uuid::new_v4();
            connection
                .execute(
                    "insert into user_agents (
                         id, user_id, credential_id, provider, handle, display_name,
                         description, avatar_seed
                     ) values ($1, $2, null, $3, $4, 'Claude', 'Works on my computer',
                         'hatchling:4')",
                    &[&agent, &user, &claude_code_lane::PROVIDER, &CLAUDE],
                )
                .await?;
            claude_agents.push(agent);
        }
        for conversation in [space.log, space.other_chat] {
            connection
                .execute(
                    "insert into conversations (id, project_id, created_by, metadata, visibility)
                     values ($1, $2, $3, '{}'::jsonb, 'public')",
                    &[&conversation, &space.project_id, &space.owner],
                )
                .await?;
        }
        drop(connection);
        // Everyone already has their @octo, as anyone who has sent to it
        // does: two first sends at once race to create it.
        for user in [space.owner, space.member, space.guest] {
            let mut connection = pool.get().await?;
            let transaction = connection.transaction().await?;
            crate::ai_agents::load_or_create_octo_agent_profile(&transaction, &user)
                .await
                .map_err(|(status, error)| anyhow::anyhow!("octo: {status} {}", error.message))?;
            transaction.commit().await?;
        }
        for runtime in [space.runtime, space.other_machine] {
            insert_runtime(
                &pool,
                runtime,
                space.project_id,
                "self-hosted",
                capabilities(Some(space.owner), json!({})),
                "ready",
                600,
            )
            .await?;
        }
        let mut lane_runtimes = Vec::new();
        for owner in [space.owner, space.owner, space.member] {
            let id = Uuid::new_v4();
            insert_runtime(
                &pool,
                id,
                space.project_id,
                "self-hosted",
                capabilities(Some(owner), lane_ready()),
                "ready",
                600,
            )
            .await?;
            lane_runtimes.push(id);
        }
        Ok(Self {
            harness: Harness {
                pool,
                state,
                app,
                space,
            },
            desktop: lane_runtimes[0],
            second_desktop: lane_runtimes[1],
            member_desktop: lane_runtimes[2],
            owner_claude: claude_agents[0],
            member_claude: claude_agents[1],
            owner_credential: owner_credential.expect("owner credential"),
            service_user,
        })
    }

    fn space(&self) -> &Space {
        &self.harness.space
    }

    fn pool(&self) -> &PgPool {
        &self.harness.pool
    }

    fn token(&self, user: Uuid) -> String {
        self.harness.token(user)
    }

    fn owner(&self) -> String {
        self.token(self.space().owner)
    }

    /// A new conversation of the owner's that everyone in the space reads.
    async fn chat(&self) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        sql(
            self.pool(),
            "insert into conversations (id, project_id, created_by, metadata, visibility)
             values ($1, $2, $3, '{}'::jsonb, 'public')",
            &[&id, &self.space().project_id, &self.space().owner],
        )
        .await?;
        Ok(id)
    }

    /// A computer of the space's.
    async fn computer(
        &self,
        provider: &str,
        capabilities: JsonValue,
        status: &str,
        seen_in_seconds: i64,
    ) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        insert_runtime(
            self.pool(),
            id,
            self.space().project_id,
            provider,
            capabilities,
            status,
            seen_in_seconds,
        )
        .await?;
        Ok(id)
    }

    async fn send(
        &self,
        token: &str,
        conversation: Uuid,
        body: &JsonValue,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        self.harness
            .call(
                "POST",
                format!("/conversations/{conversation}/messages"),
                Some(token),
                Some(body.clone()),
            )
            .await
    }

    async fn written(&self) -> anyhow::Result<Written> {
        let row = self
            .pool()
            .get()
            .await?
            .query_one(
                "select (select count(*) from prompts where project_id = $1),
                        (select count(*) from runs where project_id = $1),
                        (select count(*) from conversation_messages where project_id = $1),
                        (select count(*) from agent_jobs where project_id = $1),
                        (select count(*) from ai_usage_jobs where project_id = $1),
                        (select count(*) from org_credit_ledger where org_id = $2),
                        (select count(*) from conversation_send_queue where project_id = $1),
                        (select count(*) from runtimes where project_id = $1)",
                &[&self.space().project_id, &self.space().org_id],
            )
            .await?;
        Ok(Written {
            prompts: row.get(0),
            runs: row.get(1),
            messages: row.get(2),
            jobs: row.get(3),
            platform_jobs: row.get(4),
            ledger: row.get(5),
            queued: row.get(6),
            runtimes: row.get(7),
        })
    }

    /// `token`'s holder sends `body` to `conversation`: refused as `expected`,
    /// with nothing written.
    async fn refused(
        &self,
        token: &str,
        conversation: Uuid,
        body: JsonValue,
        expected: Expected,
    ) -> anyhow::Result<JsonValue> {
        let before = self.written().await?;
        let (status, response) = self.send(token, conversation, &body).await?;
        assert_eq!(
            (
                status,
                response["code"].as_str(),
                response["details"]["reason"].as_str()
            ),
            (expected.0, Some(expected.1), Some(expected.2)),
            "{body}: {response}"
        );
        assert_eq!(self.written().await?, before, "{body} wrote something");
        Ok(response)
    }

    /// The request `context`'s send of `body` to `conversation` makes inside
    /// dispatch, as the message route builds it, then `adjust`ed as an
    /// internal caller would.
    fn request(
        &self,
        context: &RequestContext,
        conversation: Uuid,
        body: JsonValue,
        adjust: impl FnOnce(&mut DispatchPromptNormalized),
    ) -> anyhow::Result<DispatchPromptNormalized> {
        let raw: DispatchPromptRequest = serde_json::from_value(with(
            body,
            json!({
                "projectId": self.space().project_id.to_string(),
                "conversationId": conversation.to_string(),
            }),
        ))?;
        let mut request = crate::dispatch::normalize_dispatch_request(raw)
            .map_err(|(status, error)| anyhow::anyhow!("normalize: {status} {}", error.message))?;
        request.trigger =
            JobTrigger::of_send(&self.harness.state.config, context, &request.metadata);
        crate::conversations::inject_conversation_metadata(&mut request.metadata, &conversation);
        adjust(&mut request);
        Ok(request)
    }

    /// An internal caller's dispatch of `body` to `conversation` as
    /// `context`, `adjust`ed: its job.
    async fn dispatched_directly(
        &self,
        context: RequestContext,
        conversation: Uuid,
        body: JsonValue,
        adjust: impl FnOnce(&mut DispatchPromptNormalized),
    ) -> anyhow::Result<Uuid> {
        let request = self.request(&context, conversation, body, adjust)?;
        let response =
            crate::dispatch::process_dispatch_prompt(&self.harness.state, &context, request)
                .await
                .map_err(|(status, error)| {
                    anyhow::anyhow!("dispatch: {status} {}", error.message)
                })?;
        response
            .job_id
            .ok_or_else(|| anyhow::anyhow!("dispatch queued no job"))
    }

    /// `token`'s holder sends `body` to `conversation`: admitted, and its job.
    async fn admitted_as(
        &self,
        token: &str,
        conversation: Uuid,
        body: &JsonValue,
    ) -> anyhow::Result<Uuid> {
        let (status, response) = self.send(token, conversation, body).await?;
        anyhow::ensure!(status == StatusCode::OK, "send: {status} {response}");
        Uuid::parse_str(response["jobId"].as_str().unwrap_or_default())
            .map_err(|_| anyhow::anyhow!("send queued no job: {response}"))
    }

    /// The owner sends `body` to `conversation`: admitted, and its job.
    async fn admitted(&self, conversation: Uuid, body: &JsonValue) -> anyhow::Result<Uuid> {
        self.admitted_as(&self.owner(), conversation, body).await
    }

    async fn job(&self, id: Uuid) -> anyhow::Result<Job> {
        let row = self
            .pool()
            .get()
            .await?
            .query_one(
                "select engine, credential_id, grant_ids, target_runtime_id,
                        trigger_received_at, parent_job_id, plan_group_id, agent_role,
                        status, lease_attempts, run_id, payload
                   from agent_jobs where id = $1",
                &[&id],
            )
            .await?;
        Ok(Job {
            engine: row.get("engine"),
            credential_id: row.get("credential_id"),
            grant_ids: row.get("grant_ids"),
            target_runtime_id: row.get("target_runtime_id"),
            trigger_received_at: row.get("trigger_received_at"),
            parent_job_id: row.get("parent_job_id"),
            plan_group_id: row.get("plan_group_id"),
            agent_role: row.get("agent_role"),
            status: row.get("status"),
            lease_attempts: row.get("lease_attempts"),
            run_id: row.get("run_id"),
            payload: row.get::<_, PgJson<JsonValue>>("payload").0,
        })
    }

    /// The jobs of `conversation`, oldest first.
    async fn jobs_in(&self, conversation: Uuid) -> anyhow::Result<Vec<Uuid>> {
        Ok(self
            .pool()
            .get()
            .await?
            .query(
                "select id from agent_jobs where conversation_id = $1
                  order by created_at, id",
                &[&conversation],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect())
    }

    /// The jobs a send answered with `response` started: the lane ones, and
    /// the others.
    async fn jobs_of(&self, response: &JsonValue) -> anyhow::Result<(Vec<Job>, Vec<Job>)> {
        let ids = match response["jobIds"].as_array() {
            Some(ids) => ids.clone(),
            None => vec![response["jobId"].clone()],
        };
        let mut jobs = Vec::new();
        for id in ids {
            let id = Uuid::parse_str(id.as_str().unwrap_or_default())
                .map_err(|_| anyhow::anyhow!("send queued no job: {response}"))?;
            jobs.push(self.job(id).await?);
        }
        Ok(jobs.into_iter().partition(|job| job.engine.is_some()))
    }

    /// `user`'s own agent with `handle`.
    async fn agent_of(&self, user: Uuid, handle: &str) -> anyhow::Result<Uuid> {
        sql_one(
            self.pool(),
            "select id from user_agents
              where user_id = $1 and lower(handle) = $2 and deleted_at is null",
            &[&user, &handle],
        )
        .await
    }

    /// `agent`'s AI as stored: its provider and its connection.
    async fn ai_of(&self, agent: Uuid) -> anyhow::Result<(String, Option<Uuid>)> {
        let row = self
            .pool()
            .get()
            .await?
            .query_one(
                "select provider, credential_id from user_agents where id = $1",
                &[&agent],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    /// How many agents `user` has.
    async fn agents_of(&self, user: Uuid) -> anyhow::Result<i64> {
        sql_one(
            self.pool(),
            "select count(*) from user_agents where user_id = $1 and deleted_at is null",
            &[&user],
        )
        .await
    }

    /// Ends every queued or leased job of the space, as their completions
    /// would.
    async fn end_jobs(&self) -> anyhow::Result<()> {
        sql(
            self.pool(),
            "update agent_jobs set status = 'completed', completed_at = now()
              where project_id = $1 and status in ('queued', 'leased')",
            &[&self.space().project_id],
        )
        .await?;
        Ok(())
    }

    /// Ends `job`, as its completion would.
    async fn end_job(&self, job: Uuid) -> anyhow::Result<()> {
        sql(
            self.pool(),
            "update agent_jobs set status = 'completed', completed_at = now() where id = $1",
            &[&job],
        )
        .await?;
        Ok(())
    }

    /// An ordinary job queued in a chat of its own, as a parent for a row the
    /// engine CHECK refuses.
    async fn queued_job(&self) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        let conversation = self.chat().await?;
        sql(
            self.pool(),
            "insert into agent_jobs (id, project_id, conversation_id, intent, status, payload)
             values ($1, $2, $3, 'feature', 'queued',
                     '{\"metadata\":{\"agent\":{\"handle\":\"helper\"}}}'::jsonb)",
            &[&id, &self.space().project_id, &conversation],
        )
        .await?;
        Ok(id)
    }

    async fn metadata_of(&self, query: &str, id: Uuid) -> anyhow::Result<JsonValue> {
        Ok(sql_one::<Option<JsonValue>>(self.pool(), query, &[&id])
            .await?
            .unwrap_or(JsonValue::Null))
    }

    /// The owner's send to their own @claude in a new chat: the chat, and the
    /// turn's job, which waits for one of the owner's computers.
    async fn lane_turn(&self) -> anyhow::Result<(Uuid, Uuid)> {
        let chat = self.chat().await?;
        let job = self
            .admitted(chat, &lane_send(lane_metadata(json!({}))))
            .await?;
        Ok((chat, job))
    }

    /// `runtime` calls an agent route with its own token.
    async fn agent_call(
        &self,
        runtime: Uuid,
        path: impl Into<String>,
        body: JsonValue,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let token = self.harness.agent_token(runtime).await?;
        self.harness
            .call("POST", path, Some(&token), Some(body))
            .await
    }

    /// `runtime` asks for up to `max` jobs, as a runtime that runs its jobs
    /// with a separate workspace token does: the jobs it gets.
    async fn lease_jobs(&self, runtime: Uuid, max: u32) -> anyhow::Result<Vec<JsonValue>> {
        let (status, body) = self
            .agent_call(
                runtime,
                "/agent/lease",
                json!({ "max": max, "lease_seconds": 120, "supports_workspace_token": true }),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "lease: {status} {body}");
        Ok(body["jobs"].as_array().cloned().unwrap_or_default())
    }

    /// `runtime`, asking for up to five jobs, gets `job` alone.
    async fn lease_one(&self, runtime: Uuid, job: Uuid) -> anyhow::Result<JsonValue> {
        let leased = self.lease_jobs(runtime, 5).await?;
        anyhow::ensure!(
            leased.len() == 1 && leased[0]["id"] == json!(job),
            "{runtime} leased {leased:?} for {job}"
        );
        Ok(leased[0].clone())
    }

    /// `runtime` leases nothing.
    async fn leases_nothing(&self, runtime: Uuid, what: &str) -> anyhow::Result<()> {
        let leased = self.lease_jobs(runtime, 5).await?;
        anyhow::ensure!(leased.is_empty(), "{what}: {runtime} leased {leased:?}");
        Ok(())
    }

    async fn set_capabilities(&self, runtime: Uuid, capabilities: JsonValue) -> anyhow::Result<()> {
        sql(
            self.pool(),
            "update runtimes set capabilities = $2 where id = $1",
            &[&runtime, &PgJson(capabilities)],
        )
        .await?;
        Ok(())
    }

    /// Pins `job` to `runtime`, or unpins it.
    async fn pin(&self, job: Uuid, runtime: Option<Uuid>) -> anyhow::Result<()> {
        sql(
            self.pool(),
            "update agent_jobs set target_runtime_id = $2 where id = $1",
            &[&job, &runtime],
        )
        .await?;
        Ok(())
    }

    /// Puts `job` back in the queue after a lease of it, as the idle release
    /// puts back an expired lease.
    async fn put_back(&self, job: Uuid) -> anyhow::Result<()> {
        sql(
            self.pool(),
            "update agent_jobs set status = 'queued', leased_by_runtime_id = null,
                    leased_at = null, lease_expires_at = null
              where id = $1",
            &[&job],
        )
        .await?;
        Ok(())
    }

    /// `job`'s status, error message and proxy metadata.
    async fn ended(&self, job: Uuid) -> anyhow::Result<(String, Option<String>, JsonValue)> {
        let row = self
            .pool()
            .get()
            .await?
            .query_one(
                "select status, error_message, proxy_metadata from agent_jobs where id = $1",
                &[&job],
            )
            .await?;
        Ok((
            row.get(0),
            row.get(1),
            row.get::<_, Option<JsonValue>>(2)
                .unwrap_or(JsonValue::Null),
        ))
    }

    /// The failure message recorded for `run`: its content and metadata.
    async fn failure_message(&self, run: Uuid) -> anyhow::Result<(String, JsonValue)> {
        let row = self
            .pool()
            .get()
            .await?
            .query_one(
                "select content, metadata from conversation_messages
                  where run_id = $1 and role = 'assistant'
                    and metadata ->> 'messageType' = 'error'
                  order by created_at desc limit 1",
                &[&run],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    /// `run`'s status.
    async fn run_status(&self, run: Uuid) -> anyhow::Result<String> {
        sql_one(
            self.pool(),
            "select status from runs where id = $1",
            &[&run],
        )
        .await
    }

    /// How many messages `run` has.
    async fn messages_of_run(&self, run: Uuid) -> anyhow::Result<i64> {
        sql_one(
            self.pool(),
            "select count(*) from conversation_messages where run_id = $1",
            &[&run],
        )
        .await
    }

    /// An ordinary job of the owner's, on their own connection, queued for
    /// `runtime` in `conversation` at `priority`, with `metadata` over its
    /// payload's own.
    async fn queue_codex_job(
        &self,
        runtime: Uuid,
        conversation: Uuid,
        priority: i32,
        metadata: JsonValue,
    ) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        let payload = json!({
            "user_id": self.space().owner.to_string(),
            "metadata": with(json!({ "agent": { "handle": "helper" } }), metadata),
        });
        sql(
            self.pool(),
            "insert into agent_jobs (
                 id, project_id, conversation_id, intent, status, priority, payload,
                 credential_id, target_runtime_id
             ) values ($1, $2, $3, 'feature', 'queued', $4, $5, $6, $7)",
            &[
                &id,
                &self.space().project_id,
                &conversation,
                &priority,
                &PgJson(payload),
                &self.owner_credential,
                &runtime,
            ],
        )
        .await?;
        Ok(id)
    }

    /// Runs one tick of the controller's idle sweep, with the space held as
    /// active in memory, so its idle release requeues none of its leases.
    async fn sweep_while_active(&self) -> anyhow::Result<()> {
        let state = &self.harness.state;
        state
            .runtime_activity
            .mark_active(self.space().project_id, Some(600), Some(Utc::now()))
            .await;
        crate::runtime::sweep_idle_activity(state).await
    }

    /// A runtime stop's transaction for `runtime`, committed: the jobs it put
    /// back in the queue, and the lane turns it failed, whose end it leaves
    /// to be written once it has committed ([`Self::record_stopped_turn`]).
    async fn stop_runtime_only(
        &self,
        runtime: Uuid,
    ) -> anyhow::Result<(Vec<Uuid>, Vec<crate::runtime::FailedClaudeCodeTurn>)> {
        let mut connection = self.pool().get().await?;
        let transaction = connection.transaction().await?;
        let details = crate::runtime::fetch_runtime_for_update(&transaction, &runtime)
            .await
            .map_err(|(status, error)| anyhow::anyhow!("runtime: {status} {}", error.message))?;
        let outcome = crate::runtime::perform_runtime_stop(
            &transaction,
            &details,
            crate::runtime::StopOptions {
                source: "test",
                reason: Some("unit_test".to_string()),
                skip_if_active_jobs: false,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await
        .map_err(|(status, error)| anyhow::anyhow!("stop: {status} {}", error.message))?;
        transaction.commit().await?;
        Ok((outcome.requeued_jobs, outcome.failed_claude_code_turns))
    }

    /// Writes what a runtime stop leaves of a lane turn it failed, as the
    /// stop's publish does once it has committed: what it wrote.
    async fn record_stopped_turn(
        &self,
        turn: &crate::runtime::FailedClaudeCodeTurn,
    ) -> anyhow::Result<crate::runtime::RecordedClaudeCodeTurnEnd> {
        crate::runtime::record_failed_claude_code_turn(&self.harness.state, turn)
            .await
            .map_err(|(status, error)| anyhow::anyhow!("record: {status} {}", error.message))
    }

    /// Stops `runtime` as a runtime stop does, writes what it leaves of each
    /// lane turn it failed, then brings the runtime back: the jobs the stop
    /// put back in the queue, and the lane turns it failed, each with whether
    /// it recorded a failure message.
    async fn stop_runtime(&self, runtime: Uuid) -> anyhow::Result<(Vec<Uuid>, Vec<(Uuid, bool)>)> {
        let (requeued, turns) = self.stop_runtime_only(runtime).await?;
        let mut failed = Vec::new();
        for turn in &turns {
            failed.push((
                turn.job_id,
                self.record_stopped_turn(turn).await?.message.is_some(),
            ));
        }
        sql(
            self.pool(),
            "update runtimes set status = 'ready', last_seen_at = now() where id = $1",
            &[&runtime],
        )
        .await?;
        Ok((requeued, failed))
    }

    /// Moves the end of `job`, a lane turn a runtime stop failed, `seconds`
    /// into the past.
    async fn stopped_ago(&self, job: Uuid, seconds: i64) -> anyhow::Result<()> {
        sql(
            self.pool(),
            "update agent_jobs set completed_at = now() - $2::bigint * interval '1 second'
              where id = $1",
            &[&job, &seconds],
        )
        .await?;
        Ok(())
    }

    /// What a stopped lane turn's end wrote for `run`: its failure messages
    /// and its Home rows.
    async fn stopped_turn_rows(&self, run: Uuid) -> anyhow::Result<(i64, i64)> {
        let messages = sql_one(
            self.pool(),
            "select count(*) from conversation_messages
              where run_id = $1 and metadata ->> 'kind' = $2",
            &[&run, &claude_code_lane::MACHINE_STOPPED],
        )
        .await?;
        let home_rows = sql_one(
            self.pool(),
            "select count(*) from activity_events where run_id = $1 and kind = $2",
            &[&run, &crate::activity::KIND_RUN_FAILED],
        )
        .await?;
        Ok((messages, home_rows))
    }

    /// Everyone in `chat` hears once that the lane turn of `run` failed: the
    /// chat's durable notifications hold one `run.failed`, for `run`, which
    /// reaches its sender, and no `conversation.reply` for any of the run's
    /// own messages, its failure message among them.
    async fn assert_failure_notified_once(
        &self,
        chat: Uuid,
        run: Uuid,
        what: &str,
    ) -> anyhow::Result<()> {
        let connection = self.pool().get().await?;
        let run_failures = connection
            .query(
                "select producer_key from notification_events
                  where conversation_id = $1 and event_name = 'run.failed'",
                &[&chat],
            )
            .await?
            .iter()
            .map(|row| row.get::<_, String>(0))
            .collect::<Vec<_>>();
        assert_eq!(run_failures, vec![format!("run.failed:{run}")], "{what}");
        let replies: i64 = connection
            .query_one(
                "select count(*) from notification_events event
                   join conversation_messages message
                     on event.producer_key = 'conversation.reply:' || message.id::text
                  where message.run_id = $1 and message.role = 'assistant'",
                &[&run],
            )
            .await?
            .get(0);
        assert_eq!(replies, 0, "{what}: a reply of the run notified");
        let sender_told: i64 = connection
            .query_one(
                "select count(*) from notification_recipients recipient
                   join notification_events event on event.id = recipient.event_id
                  where event.producer_key = $1 and recipient.user_id = $2",
                &[&format!("run.failed:{run}"), &self.space().owner],
            )
            .await?
            .get(0);
        assert_eq!(sender_told, 1, "{what}: its sender was not told");
        Ok(())
    }

    /// A member and the service role each record an assistant message in
    /// `chat` that claims to be the end of the lane turn `job`, as a runtime
    /// stop writes it: the stop's words and kind, and the turn's `jobId`,
    /// which every step of the turn shows everyone in the chat. Neither is the
    /// controller's own: the member's keeps no such kind, and the service
    /// role's keeps it with no lane stamp and no run.
    async fn record_claims_of_a_stopped_turns_end(
        &self,
        chat: Uuid,
        job: Uuid,
    ) -> anyhow::Result<()> {
        let claim = json!({ "jobId": job, "kind": claude_code_lane::MACHINE_STOPPED });
        let member = self.space().member;
        for (token, author) in [
            (self.token(member), Some(member)),
            (SERVICE_ROLE.to_string(), None),
        ] {
            let (status, recorded) = self
                .harness
                .call(
                    "POST",
                    format!("/conversations/{chat}/messages/record"),
                    Some(&token),
                    Some(json!({
                        "role": "assistant",
                        "content": claude_code_lane::MACHINE_STOPPED_MESSAGE,
                        "metadata": claim,
                    })),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "record: {status} {recorded}");
            let id = Uuid::parse_str(recorded["id"].as_str().unwrap_or_default())?;
            let row = self
                .pool()
                .get()
                .await?
                .query_one(
                    "select created_by, run_id, metadata from conversation_messages
                      where id = $1 and role = 'assistant'",
                    &[&id],
                )
                .await?;
            let (created_by, run_id, metadata): (Option<Uuid>, Option<Uuid>, JsonValue) =
                (row.get(0), row.get(1), row.get(2));
            assert_eq!(created_by, author, "{metadata}");
            assert_eq!(run_id, None, "{metadata}");
            assert_eq!(metadata["jobId"], json!(job), "{metadata}");
            assert!(metadata.get("claudeCode").is_none(), "{metadata}");
            let kind = match author {
                Some(_) => None,
                None => Some(&claim["kind"]),
            };
            assert_eq!(metadata.get("kind"), kind, "{metadata}");
        }
        Ok(())
    }

    /// The owner's daily automation of [`WORDS`] for their own @claude, with
    /// `extra` over its body: its id and its thread.
    async fn automation(&self, extra: JsonValue) -> anyhow::Result<(Uuid, Uuid)> {
        let (status, created) = self
            .harness
            .call(
                "POST",
                format!("/projects/{}/automations", self.space().project_id),
                Some(&self.owner()),
                Some(with(
                    json!({
                        "name": "Nightly build check",
                        "promptText": WORDS,
                        "scheduleKind": "hourly",
                        "intervalHours": 24,
                        "timezone": "UTC",
                        "runtimeMode": "auto",
                        "metadata": { "agentSelection": { "active": [CLAUDE], "mentions": [CLAUDE] } },
                    }),
                    extra,
                )),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "automation: {status} {created}");
        Ok((
            Uuid::parse_str(created["id"].as_str().unwrap_or_default())?,
            Uuid::parse_str(created["conversationId"].as_str().unwrap_or_default())?,
        ))
    }

    /// The owner runs `automation` now: when its attempt, which runs in the
    /// background, last ran it, once that attempt is over.
    async fn run_automation(&self, automation: Uuid) -> anyhow::Result<DateTime<Utc>> {
        let (status, body) = self
            .harness
            .call(
                "POST",
                format!("/automations/{automation}/run"),
                Some(&self.owner()),
                None,
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "run now: {status} {body}");
        // Run now holds the automation until its attempt is over.
        eventually("the automation's attempt to be over", || async {
            let row = self
                .pool()
                .get()
                .await?
                .query_one(
                    "select locked_until is null, last_run_at from automations where id = $1",
                    &[&automation],
                )
                .await?;
            Ok(row
                .get::<_, bool>(0)
                .then(|| row.get::<_, Option<DateTime<Utc>>>(1))
                .flatten())
        })
        .await
    }
}

/// What has been published for a lane turn a runtime stop failed, in order:
/// its failure message in `chat` and its run's end, each as its event's kind
/// and data.
fn stopped_turn_events(
    events: &mut tokio::sync::broadcast::Receiver<crate::state::ControllerEvent>,
    chat: Uuid,
    run: Uuid,
) -> Vec<(String, JsonValue)> {
    let mut published = Vec::new();
    while let Ok(event) = events.try_recv() {
        let of_the_turn = match event.kind.as_str() {
            "conversation.message_created" => {
                event.conversation_id == Some(chat)
                    && event.data["metadata"]["kind"] == json!(claude_code_lane::MACHINE_STOPPED)
            }
            "run.completed" => event.run_id == Some(run),
            _ => false,
        };
        if of_the_turn {
            published.push((event.kind, event.data));
        }
    }
    published
}

/// A failure message of a lane turn the controller ended as `code`: Studio
/// words it by `aiAccessMode` and `claudeCodeFailure`, and shows it as a
/// lane failure only with the controller's own stamps, which no recorded
/// message keeps (docs/Local-Engine-Turns.md 5.5).
fn assert_lane_failure(metadata: &JsonValue, code: &str, what: &str) {
    assert_lane_stamps(metadata, what);
    assert_eq!(
        metadata["claudeCodeFailure"],
        json!(code),
        "{what}: {metadata}"
    );
}

async fn insert_runtime(
    pool: &PgPool,
    id: Uuid,
    project: Uuid,
    provider: &str,
    capabilities: JsonValue,
    status: &str,
    seen_in_seconds: i64,
) -> anyhow::Result<()> {
    sql(
        pool,
        "insert into runtimes (
             id, project_id, provider, status, idle_ttl_seconds, last_seen_at, capabilities
         ) values ($1, $2, $3, $4, 600, now() + $5::bigint * interval '1 second', $6)",
        &[
            &id,
            &project,
            &provider,
            &status,
            &seen_in_seconds,
            &PgJson(capabilities),
        ],
    )
    .await?;
    Ok(())
}

fn reason_of(error: &ApiError) -> Option<&str> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("reason"))
        .and_then(JsonValue::as_str)
}

/// The controller's lane stamps, where `metadata` keeps them.
fn assert_lane_stamps(metadata: &JsonValue, what: &str) {
    assert_eq!(
        metadata["claudeCode"],
        json!({ "version": 1 }),
        "{what}: {metadata}"
    );
    assert_eq!(
        metadata["aiAccessMode"],
        json!("claude-code"),
        "{what}: {metadata}"
    );
    assert_eq!(
        metadata["managedAiUsed"],
        json!(false),
        "{what}: {metadata}"
    );
}

/// `job` is a turn of `person`'s own `agent`, a Claude Code agent, that waits
/// for one of their computers: it runs on their own Claude Code, stamped so,
/// with no connection, device grant or runtime pin.
fn assert_lane_job(job: &Job, person: Uuid, agent: Uuid, what: &str) {
    assert_eq!(
        job.engine.as_deref(),
        Some(claude_code_lane::ENGINE),
        "{what}"
    );
    assert_eq!(job.credential_id, None, "{what}");
    assert_eq!(job.grant_ids, None, "{what}");
    assert_eq!(job.target_runtime_id, None, "{what}");
    assert_eq!(job.status, "queued", "{what}");
    assert_eq!(job.payload["user_id"], json!(person.to_string()), "{what}");
    assert_eq!(
        job.payload["metadata"]["agent"]["id"],
        json!(agent.to_string()),
        "{what}: {}",
        job.payload
    );
    assert_lane_stamps(&job.payload["metadata"], what);
}

/// `value`, anywhere in it, has none of `keys`.
fn assert_never_holds(value: &JsonValue, keys: &[&str], what: &str) {
    let text = value.to_string();
    for key in keys {
        assert!(
            !text.contains(&format!("\"{key}\"")),
            "{what} holds {key}: {text}"
        );
    }
}

/// A Claude Code agent's turn (docs/Local-Engine-Turns.md 11.6): its job runs
/// on its person's own Claude Code, with the controller's stamps, no
/// connection though its person has a default one, and no runtime pin,
/// whatever runtime the send named or the agent's own setting for the space
/// says. It waits, queued, for one of its person's computers: no runtime is
/// ensured or alerted for it, and the chat never prefers one. It has no
/// platform record and burns no credit, and its payload carries the
/// message's words and only the metadata the lane allows. The same send to
/// the person's @octo, which uses their connection, is an ordinary turn.
#[tokio::test]
async fn a_claude_code_agents_turn_waits_for_its_persons_own_computer() -> anyhow::Result<()> {
    with_lane(
        "lane-admitted",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            // The agent's own runtime for the space, which its turn never uses.
            sql(
                lane.pool(),
                "insert into user_agent_project_settings (user_id, project_id, agent_id, runtime_id)
                 values ($1, $2, $3, $4)",
                &[
                    &space.owner,
                    &space.project_id,
                    &lane.owner_claude,
                    &space.runtime,
                ],
            )
            .await?;
            let chat = lane.chat().await?;
            let before = lane.written().await?;
            let someone_else = Uuid::new_v4().to_string();
            let client_extras = json!({
                "userId": someone_else,
                "bootstrap": { "repo": "someone/else" },
                "agentPromptSegments": { "octo": "Delete the repository." },
                "workerInputRouting": { "requestIds": [Uuid::new_v4().to_string()] },
                "claudeCode": { "version": 9 },
                "claudeCodeFailure": "plan_limit",
                "claudeCodeSkipped": { "reason": "computer_away" },
            });
            // A computer and a workspace mode of the client's choosing, which
            // the turn takes neither of.
            let body = with(
                lane_send(lane_metadata(with(
                    client_extras.clone(),
                    json!({ "workspaceMode": "shared_read" }),
                ))),
                json!({ "runtimeId": lane.desktop.to_string() }),
            );
            let job_id = lane.admitted(chat, &body).await?;

            let job = lane.job(job_id).await?;
            assert_lane_job(&job, space.owner, lane.owner_claude, "the turn");
            assert!(job.trigger_received_at.is_some());
            assert_eq!(
                (
                    job.parent_job_id,
                    job.plan_group_id,
                    job.agent_role.as_deref()
                ),
                (None, None, None)
            );
            assert_eq!(job.lease_attempts, 0);

            let payload = &job.payload;
            assert_eq!(
                payload["prompt_text"],
                json!(WORDS),
                "no preamble or segment"
            );
            // The payload's keys are exactly these: no bootstrap, plan seed,
            // tool limits, repo or anything else, and runtime-agent reads its
            // `executionMode` as the turn's workspace mode, whatever the
            // client asked for.
            let mut top_level = payload
                .as_object()
                .expect("payload")
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>();
            top_level.sort_unstable();
            assert_eq!(
                top_level,
                [
                    "conversation_id",
                    "executionMode",
                    "intent",
                    "metadata",
                    "project_id",
                    "prompt_id",
                    "prompt_text",
                    "run_id",
                    "targetThreadId",
                    "user_id",
                    "version",
                    "writeIntent",
                ],
                "{payload}"
            );
            assert_eq!(
                payload["executionMode"],
                json!(claude_code_lane::WORKSPACE_MODE)
            );
            assert_eq!(payload["executionMode"], json!("shared_write"));
            assert_eq!(payload["intent"], json!("feature"));
            assert_eq!(payload["writeIntent"], json!(true));
            // No `runtimePreference`: a send whose every agent uses Claude
            // Code names no runtime of the space's.
            let metadata = payload["metadata"].as_object().expect("payload metadata");
            let mut keys = metadata.keys().map(String::as_str).collect::<Vec<_>>();
            keys.sort_unstable();
            assert_eq!(
                keys,
                [
                    "agent",
                    "aiAccessMode",
                    "claudeCode",
                    "conversationVisibility",
                    "input",
                    "managedAiUsed",
                    "writeIntent",
                    "writeScope",
                ],
                "{payload}"
            );
            assert_eq!(metadata["agent"]["handle"], json!(CLAUDE));
            assert_eq!(metadata["writeScope"]["mode"], json!("unscoped"));
            assert_eq!(metadata["input"], json!({ "kind": "person" }));
            assert_eq!(metadata["writeIntent"], json!(true));

            let run_id = job.run_id.expect("run");
            let run = lane
                .metadata_of("select metadata from runs where id = $1", run_id)
                .await?;
            assert_lane_stamps(&run, "run");
            assert!(run.get("runtimeAlert").is_none(), "no runtime alert: {run}");
            let prompt = lane
                .metadata_of(
                    "select p.metadata from prompts p join runs r on r.prompt_id = p.id
                      where r.id = $1",
                    run_id,
                )
                .await?;
            assert_lane_stamps(&prompt, "prompt");
            let message = lane
                .metadata_of(
                    "select metadata from conversation_messages
                      where run_id = $1 and role = 'user'",
                    run_id,
                )
                .await?;
            assert_lane_stamps(&message, "message");
            // No trigger kind: device grants, the one feature that reads it,
            // are off for the person, whom only the lane's switch covers.
            assert!(message.get("trigger").is_none(), "{message}");
            let content: String = sql_one(
                lane.pool(),
                "select content from conversation_messages where run_id = $1 and role = 'user'",
                &[&run_id],
            )
            .await?;
            assert_eq!(content, WORDS);
            for (what, value) in [
                ("payload", payload),
                ("run", &run),
                ("prompt", &prompt),
                ("message", &message),
            ] {
                assert_never_holds(
                    value,
                    &[
                        "claudeCodeFailure",
                        "claudeCodeSkipped",
                        "workerInputRouting",
                    ],
                    what,
                );
            }
            // The chat never comes to prefer a runtime for it.
            let conversation = lane
                .metadata_of("select metadata from conversations where id = $1", chat)
                .await?;
            assert!(
                conversation.get("runtimePreference").is_none(),
                "{conversation}"
            );
            // One prompt, run, message and job; no runtime, platform record or
            // credit.
            assert_eq!(
                lane.written().await?,
                Written {
                    prompts: before.prompts + 1,
                    runs: before.runs + 1,
                    messages: before.messages + 1,
                    jobs: before.jobs + 1,
                    ..before
                }
            );

            // The same send to the person's @octo is an ordinary turn of their
            // own connection, on the computer it names, words and client
            // metadata included.
            let codex_chat = lane.chat().await?;
            let mut octo = body.clone();
            octo["metadata"] = metadata_for(&["octo"], client_extras);
            let codex = lane.job(lane.admitted(codex_chat, &octo).await?).await?;
            assert_eq!(codex.engine, None);
            assert_eq!(codex.credential_id, Some(lane.owner_credential));
            assert_eq!(codex.target_runtime_id, Some(lane.desktop));
            assert_eq!(
                codex.payload["prompt_text"],
                json!("Delete the repository.")
            );
            assert_eq!(codex.payload["metadata"]["userId"], json!(someone_else));
            assert_eq!(codex.payload["metadata"]["aiAccessMode"], json!("byoc"));
            assert!(codex.payload.get("bootstrap").is_some());
            assert_never_holds(
                &codex.payload,
                &["claudeCode", "claudeCodeFailure", "claudeCodeSkipped"],
                "codex",
            );
            Ok(())
        },
    )
    .await
}

/// A lane job's payload, as dispatch builds it for the sender's own @octo set
/// to Claude Code, is the one runtime-contracts records
/// (claude_code_lane_fixtures.json), its ids aside. runtime-agent's lane tests
/// run that same payload through `LaneJob::of`, so a payload key the
/// controller renames, adds or drops fails here instead of every lane turn.
#[tokio::test]
async fn a_lane_job_payload_is_the_one_runtime_contracts_records() -> anyhow::Result<()> {
    /// `value` with each id of `ids` replaced by its placeholder.
    fn with_placeholders(value: &mut JsonValue, ids: &[(Uuid, &str)]) {
        match value {
            JsonValue::String(text) => {
                if let Some((_, placeholder)) = ids.iter().find(|(id, _)| *text == id.to_string()) {
                    *text = placeholder.to_string();
                }
            }
            JsonValue::Array(items) => {
                for item in items {
                    with_placeholders(item, ids);
                }
            }
            JsonValue::Object(map) => {
                for item in map.values_mut() {
                    with_placeholders(item, ids);
                }
            }
            _ => {}
        }
    }

    with_lane(
        "lane-recorded-payload",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let octo = lane.agent_of(space.owner, "octo").await?;
            let (status, chosen) = lane
                .harness
                .call(
                    "PATCH",
                    format!("/me/agents/{octo}"),
                    Some(&lane.owner()),
                    Some(json!({ "provider": "claude-code" })),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "Claude Code: {status} {chosen}");
            let fixtures: JsonValue = serde_json::from_str(include_str!(
                "../../runtime-contracts/src/claude_code_lane_fixtures.json"
            ))?;
            let recorded = &fixtures["laneJobPayload"];
            // The send Studio makes to @octo, the first in its chat.
            let chat = lane.chat().await?;
            let job = lane
                .job(
                    lane.admitted(
                        chat,
                        &json!({
                            "promptText": recorded["prompt_text"],
                            "intent": "feature",
                            "metadata": metadata_for(&["octo"], json!({})),
                        }),
                    )
                    .await?,
                )
                .await?;
            assert_lane_job(&job, space.owner, octo, "@octo's turn");
            let prompt = Uuid::parse_str(job.payload["prompt_id"].as_str().unwrap_or_default())?;
            let mut payload = job.payload.clone();
            with_placeholders(
                &mut payload,
                &[
                    (space.project_id, "<project_id>"),
                    (space.owner, "<user_id>"),
                    (chat, "<conversation_id>"),
                    (prompt, "<prompt_id>"),
                    (job.run_id.expect("run"), "<run_id>"),
                    (octo, "<agent_id>"),
                ],
            );
            assert_eq!(&payload, recorded);
            Ok(())
        },
    )
    .await
}

/// An agent's AI (docs/Local-Engine-Turns.md 11.3): its owner makes any agent
/// of theirs, @octo included, a Claude Code agent from their own session, new
/// or saved, which drops its connection, and its turns are then lane turns.
/// Clearing its connection moves it back to Instafy AI, @octo to its own, and
/// choosing a connection makes it that connection's. The choice is refused,
/// leaving every agent as it was, with a connection in the same body, to
/// someone the switch leaves out, and to the service role and a job's token,
/// neither of which is the person's own session.
#[tokio::test]
async fn any_agent_of_a_person_the_switch_covers_can_use_claude_code() -> anyhow::Result<()> {
    with_lane(
        "lane-agent-ai",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = lane.owner();
            let claude_code = || -> (String, Option<Uuid>) { ("claude-code".to_string(), None) };
            // A Codex job's token, which acts as its person there.
            let codex_chat = lane.chat().await?;
            lane.admitted(codex_chat, &octo_send(space.runtime)).await?;
            let leased = lane.harness.lease(space.runtime).await?;
            let job_token = leased["controller_token"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("no job token: {leased}"))?
                .to_string();

            // A new agent that uses Claude Code.
            let (status, created) = lane
                .harness
                .call(
                    "POST",
                    "/me/agents",
                    Some(&owner),
                    Some(json!({
                        "provider": "claude-code",
                        "handle": "reviewer",
                        "displayName": "Reviewer",
                    })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{created}");
            assert_eq!(created["provider"], json!("claude-code"), "{created}");
            assert_eq!(created["credentialId"], JsonValue::Null, "{created}");
            let reviewer = Uuid::parse_str(created["id"].as_str().unwrap_or_default())?;
            assert_eq!(lane.ai_of(reviewer).await?, claude_code());
            // Its turns are lane turns.
            let job = lane
                .admitted(
                    lane.chat().await?,
                    &lane_send(metadata_for(&["reviewer"], json!({}))),
                )
                .await?;
            assert_lane_job(
                &lane.job(job).await?,
                space.owner,
                reviewer,
                "the new agent's turn",
            );

            let choose = |agent: Uuid, body: JsonValue| {
                let lane = &lane;
                let owner = owner.clone();
                async move {
                    let (status, chosen) = lane
                        .harness
                        .call(
                            "PATCH",
                            format!("/me/agents/{agent}"),
                            Some(&owner),
                            Some(body.clone()),
                        )
                        .await?;
                    anyhow::ensure!(status == StatusCode::OK, "{body}: {status} {chosen}");
                    anyhow::Ok(chosen)
                }
            };
            // A saved agent with a connection drops it.
            let helper = space.owner_agent;
            let chosen = choose(helper, json!({ "provider": "claude-code" })).await?;
            assert_eq!(chosen["provider"], json!("claude-code"), "{chosen}");
            assert_eq!(chosen["credentialId"], JsonValue::Null, "{chosen}");
            assert_eq!(lane.ai_of(helper).await?, claude_code());
            // Clearing its connection, which it no longer has, moves it to
            // Instafy AI...
            let chosen = choose(helper, json!({ "credentialId": null })).await?;
            assert_eq!(chosen["provider"], json!("openai"), "{chosen}");
            assert_eq!(lane.ai_of(helper).await?, ("openai".to_string(), None));
            // ...and @octo to its own.
            let octo = lane.agent_of(space.owner, "octo").await?;
            choose(octo, json!({ "provider": "claude-code" })).await?;
            assert_eq!(lane.ai_of(octo).await?, claude_code());
            let chosen = choose(octo, json!({ "credentialId": null })).await?;
            assert_eq!(chosen["provider"], json!("assistant"), "{chosen}");
            assert_eq!(lane.ai_of(octo).await?, ("assistant".to_string(), None));
            // A connection makes it that connection's, and Claude Code again
            // drops it.
            let chosen = choose(
                reviewer,
                json!({ "credentialId": lane.owner_credential.to_string() }),
            )
            .await?;
            assert_eq!(chosen["provider"], json!("openai"), "{chosen}");
            assert_eq!(
                lane.ai_of(reviewer).await?,
                ("openai".to_string(), Some(lane.owner_credential))
            );
            choose(reviewer, json!({ "provider": "claude-code" })).await?;
            assert_eq!(lane.ai_of(reviewer).await?, claude_code());

            // Refused: a connection in the same body, even none; the service
            // role; and a job's token.
            let owner_agents = lane.agents_of(space.owner).await?;
            let credential = lane.owner_credential.to_string();
            for (token, method, path, body, refusal) in [
                (
                    owner.as_str(),
                    "POST",
                    "/me/agents".to_string(),
                    json!({ "provider": "claude-code", "handle": "second", "credentialId": credential }),
                    StatusCode::BAD_REQUEST,
                ),
                (
                    owner.as_str(),
                    "PATCH",
                    format!("/me/agents/{helper}"),
                    json!({ "provider": "claude-code", "credentialId": credential }),
                    StatusCode::BAD_REQUEST,
                ),
                (
                    owner.as_str(),
                    "PATCH",
                    format!("/me/agents/{helper}"),
                    json!({ "provider": "claude-code", "credentialId": null }),
                    StatusCode::BAD_REQUEST,
                ),
                (
                    SERVICE_ROLE,
                    "POST",
                    "/me/agents".to_string(),
                    json!({ "provider": "claude-code", "handle": "second" }),
                    StatusCode::UNAUTHORIZED,
                ),
                (
                    SERVICE_ROLE,
                    "PATCH",
                    format!("/me/agents/{helper}"),
                    json!({ "provider": "claude-code" }),
                    StatusCode::UNAUTHORIZED,
                ),
                (
                    job_token.as_str(),
                    "POST",
                    "/me/agents".to_string(),
                    json!({ "provider": "claude-code", "handle": "second" }),
                    StatusCode::UNAUTHORIZED,
                ),
                (
                    job_token.as_str(),
                    "PATCH",
                    format!("/me/agents/{helper}"),
                    json!({ "provider": "claude-code" }),
                    StatusCode::UNAUTHORIZED,
                ),
            ] {
                let (status, response) = lane
                    .harness
                    .call(method, path.clone(), Some(token), Some(body.clone()))
                    .await?;
                assert_eq!(status, refusal, "{method} {path} {body}: {response}");
            }
            assert_eq!(lane.agents_of(space.owner).await?, owner_agents);
            assert_eq!(lane.ai_of(helper).await?, ("openai".to_string(), None));
            assert_eq!(lane.ai_of(reviewer).await?, claude_code());

            // Refused to someone the switch leaves out, new or saved.
            let guest = lane.token(space.guest);
            let guest_helper = lane.agent_of(space.guest, "helper").await?;
            let guest_ai = lane.ai_of(guest_helper).await?;
            let guest_agents = lane.agents_of(space.guest).await?;
            for (method, path, body) in [
                (
                    "POST",
                    "/me/agents".to_string(),
                    json!({ "provider": "claude-code", "handle": CLAUDE }),
                ),
                (
                    "PATCH",
                    format!("/me/agents/{guest_helper}"),
                    json!({ "provider": "claude-code" }),
                ),
            ] {
                let (status, response) = lane
                    .harness
                    .call(method, path.clone(), Some(&guest), Some(body))
                    .await?;
                assert_eq!(
                    (status, response["code"].as_str()),
                    (
                        StatusCode::FORBIDDEN,
                        Some(claude_code_lane::TURN_NOT_ALLOWED)
                    ),
                    "{method} {path}: {response}"
                );
            }
            assert_eq!(lane.ai_of(guest_helper).await?, guest_ai);
            assert_eq!(lane.agents_of(space.guest).await?, guest_agents);
            Ok(())
        },
    )
    .await
}

/// What a Claude Code agent cannot take (docs/Local-Engine-Turns.md 11.4,
/// 11.6) is refused with its reason before a prompt, run, message, job or
/// ledger row is written, and never runs on another engine: a team plan,
/// attachments, one of Instafy's own features, an execution mode that waits
/// for an approval, a `/` command and too long a message. While the switch
/// does not cover its owner, it takes no turn at all. A send to it and to
/// another agent is refused whole. The longest message is a turn, and a
/// terminal command, which is no AI turn, runs as it does for any agent.
#[tokio::test]
async fn a_turn_claude_code_cannot_take_is_refused_before_anything_is_written() -> anyhow::Result<()>
{
    with_lane(
        "lane-refused",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = lane.owner();
            let chat = lane.chat().await?;
            let plain = || lane_send(lane_metadata(json!({})));
            for (body, reason) in [
                (
                    with(plain(), json!({ "planSeed": { "steps": ["one"] } })),
                    "team_plan",
                ),
                (
                    lane_send(lane_metadata(json!({
                        "attachments": [{ "kind": "image", "storagePath": "chat/a.png" }],
                    }))),
                    "attachments",
                ),
                (
                    with(plain(), json!({ "toolLimits": { "maxSteps": 3 } })),
                    "instafy_feature",
                ),
                (
                    with(plain(), json!({ "repo": { "owner": "o", "name": "n" } })),
                    "instafy_feature",
                ),
                (
                    with(plain(), json!({ "ui": { "requestedPreview": true } })),
                    "instafy_feature",
                ),
                (
                    lane_send(lane_metadata(json!({ "execution_mode": "approval_required" }))),
                    "execution_mode",
                ),
                (
                    with(plain(), json!({ "promptText": "/review the diff" })),
                    "command",
                ),
                (
                    with(plain(), json!({ "promptText": "  \n /compact" })),
                    "command",
                ),
                (
                    with(
                        plain(),
                        json!({ "promptText": "a".repeat(crate::config::CLAUDE_CODE_LANE_MAX_PROMPT_CHARS + 1) }),
                    ),
                    "too_long",
                ),
            ] {
                lane.refused(&owner, chat, body, unsupported(reason))
                    .await?;
            }
            // Sent to it and to another agent, the whole send is refused.
            lane.refused(
                &owner,
                chat,
                with(
                    lane_send(metadata_for(&[CLAUDE, "helper"], json!({}))),
                    json!({ "toolLimits": { "maxSteps": 3 } }),
                ),
                unsupported("instafy_feature"),
            )
            .await?;
            // A Claude Code agent whose owner the switch does not cover.
            sql(
                lane.pool(),
                "insert into user_agents (user_id, credential_id, provider, handle, avatar_seed)
                 values ($1, null, $2, $3, 'hatchling:5')",
                &[&space.guest, &claude_code_lane::PROVIDER, &CLAUDE],
            )
            .await?;
            lane.refused(&lane.token(space.guest), chat, plain(), not_allowed())
                .await?;

            // The longest message is a turn.
            let longest = with(
                plain(),
                json!({ "promptText": "é".repeat(crate::config::CLAUDE_CODE_LANE_MAX_PROMPT_CHARS) }),
            );
            let job = lane.job(lane.admitted(chat, &longest).await?).await?;
            assert_lane_job(&job, space.owner, lane.owner_claude, "the longest message");
            // A terminal command is no AI turn: it runs as it would for any
            // agent, on the runtime it names.
            let command = lane
                .job(
                    lane.admitted(
                        chat,
                        &with(
                            plain(),
                            json!({
                                "intent": "terminal_command",
                                "promptText": "npm test",
                                "runtimeId": space.runtime.to_string(),
                            }),
                        ),
                    )
                    .await?,
                )
                .await?;
            assert_eq!(command.engine, None);
            assert_eq!(command.target_runtime_id, Some(space.runtime));
            assert_never_holds(&command.payload, &["claudeCode"], "a terminal command");
            Ok(())
        },
    )
    .await
}

/// A Claude Code agent's turn can be held to the whole space or to none of
/// it, which its runtime runs read-only (docs/Local-Engine-Turns.md 11.4,
/// 11.12). A turn whose planned write scope would own part of the space, or
/// coordinate its writes with other agents writing at once, is refused with
/// the reason `write_scope` before anything is written: a send with write
/// intent to it and another agent, owned paths given for it beside another
/// agent or alone, and an explicit scope that is no scope. A read-only scope,
/// given or planned for a send to several agents without write intent, is a
/// turn, and so is the whole space beside an agent that only reads; the
/// payload names the scope.
#[tokio::test]
async fn a_claude_code_turn_held_to_part_of_the_space_is_refused_before_anything_is_written(
) -> anyhow::Result<()> {
    with_lane(
        "lane-write-scope",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = lane.owner();
            let chat = lane.chat().await?;
            let both = |extra: JsonValue| lane_send(metadata_for(&[CLAUDE, "helper"], extra));
            let both_with_scopes = |scopes: JsonValue| {
                both(json!({
                    "agentSelection": {
                        "active": [CLAUDE, "helper"],
                        "mentions": [CLAUDE, "helper"],
                        "writeScopes": scopes,
                    },
                }))
            };
            for body in [
                both(json!({})),
                both_with_scopes(json!({ "claude": ["src/"], "helper": ["docs/"] })),
                lane_send(lane_metadata(
                    json!({ "writeScope": { "ownedPaths": ["src/"] } }),
                )),
                lane_send(lane_metadata(
                    json!({ "writeScopes": { "claude": "../escape" } }),
                )),
            ] {
                lane.refused(&owner, chat, body, unsupported("write_scope"))
                    .await?;
            }

            for (what, body, scope) in [
                (
                    "an explicit read-only scope",
                    lane_send(lane_metadata(
                        json!({ "writeScope": { "mode": "read_only" } }),
                    )),
                    "read_only",
                ),
                (
                    "two agents without write intent",
                    both(json!({ "writeIntent": false })),
                    "read_only",
                ),
                (
                    "beside an agent that only reads",
                    both_with_scopes(json!({ "helper": "read_only" })),
                    "unscoped",
                ),
            ] {
                let (status, response) = lane.send(&owner, chat, &body).await?;
                anyhow::ensure!(status == StatusCode::OK, "{what}: {status} {response}");
                let (lane_jobs, _) = lane.jobs_of(&response).await?;
                assert_eq!(lane_jobs.len(), 1, "{what}: {response}");
                let job = &lane_jobs[0];
                assert_lane_job(job, space.owner, lane.owner_claude, what);
                assert_eq!(
                    job.payload["metadata"]["writeScope"]["mode"],
                    json!(scope),
                    "{what}: {}",
                    job.payload
                );
            }
            Ok(())
        },
    )
    .await
}

/// Whoever or whatever started it no longer matters
/// (docs/Local-Engine-Turns.md 11.4, 11.6): a resend, by hand or by Studio, a
/// message with no input or a device's, a goal's next step, the service role
/// acting for the person, a Codex job's own token and a send that starts its
/// chat each become a turn of the person's own Claude Code agent, as the
/// message they type does.
#[tokio::test]
async fn whoever_started_it_a_turn_claude_code_can_take_is_admitted() -> anyhow::Result<()> {
    with_lane(
        "lane-whoever",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let is_lane_turn = |job: Job, what: &str| {
                assert_lane_job(&job, space.owner, lane.owner_claude, what);
            };
            for (what, metadata) in [
                (
                    "a resend",
                    lane_metadata(json!({ "retryOfMessageId": Uuid::new_v4().to_string() })),
                ),
                (
                    "Studio's automatic resend",
                    lane_metadata(json!({
                        "retryAutomatic": true,
                        "retryOfMessageId": Uuid::new_v4().to_string(),
                    })),
                ),
                ("no input", without(lane_metadata(json!({})), &["input"])),
                (
                    "a device's input",
                    lane_metadata(
                        json!({ "input": { "kind": "device", "deviceId": "speaker-1" } }),
                    ),
                ),
            ] {
                let job = lane.admitted(chat, &lane_send(metadata)).await?;
                is_lane_turn(lane.job(job).await?, what);
            }
            // A goal's next step, which its wake-up sends in its person's name
            // with no trigger.
            let job = lane
                .dispatched_directly(
                    person_context(space.owner),
                    chat,
                    lane_send(lane_metadata(json!({
                        "goalContinuation": { "turn": 2, "source": "controller" },
                    }))),
                    |request| request.trigger = None,
                )
                .await?;
            is_lane_turn(lane.job(job).await?, "a goal's next step");
            // The service role acting for the person.
            let job = lane
                .dispatched_directly(
                    RequestContext {
                        user_id: Some(space.owner),
                        is_service_role: true,
                        scoped_claims: None,
                    },
                    chat,
                    lane_send(lane_metadata(json!({}))),
                    |_| {},
                )
                .await?;
            is_lane_turn(lane.job(job).await?, "the service role for the person");
            // A Codex job's own token, which acts as its person, never starts
            // one: an agent's job reads what teammates wrote, so its words
            // could be theirs (11.5).
            let codex_chat = lane.chat().await?;
            lane.admitted(codex_chat, &octo_send(space.runtime)).await?;
            let leased = lane.harness.lease(space.runtime).await?;
            let job_token = leased["controller_token"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("no job token: {leased}"))?
                .to_string();
            lane.refused(
                &job_token,
                codex_chat,
                lane_send(lane_metadata(json!({}))),
                unsupported("delegated"),
            )
            .await?;
            // Nor can it make an automation of a Claude Code agent's, whose
            // prompt would be its words. (A job's token can change only an
            // automation's schedule or status, whatever its agents.)
            let before = lane.written().await?;
            let (status, response) = lane
                .harness
                .call(
                    "POST",
                    format!("/projects/{}/automations", space.project_id),
                    Some(&job_token),
                    Some(json!({
                        "name": "From a job",
                        "promptText": WORDS,
                        "scheduleKind": "hourly",
                        "intervalHours": 24,
                        "timezone": "UTC",
                        "runtimeMode": "auto",
                        "metadata": { "agentSelection": { "active": [CLAUDE], "mentions": [CLAUDE] } },
                    })),
                )
                .await?;
            assert_eq!(
                (status, response["details"]["reason"].as_str()),
                (StatusCode::UNPROCESSABLE_ENTITY, Some("delegated")),
                "{response}"
            );
            assert_eq!(lane.written().await?, before, "a job's automation wrote something");
            // A send that starts its chat.
            let (status, response) = lane
                .harness
                .call(
                    "POST",
                    "/dispatch-prompt",
                    Some(&lane.owner()),
                    Some(with(
                        lane_send(lane_metadata(json!({}))),
                        json!({ "projectId": space.project_id.to_string() }),
                    )),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "dispatch: {status} {response}");
            let job = Uuid::parse_str(response["jobId"].as_str().unwrap_or_default())?;
            is_lane_turn(lane.job(job).await?, "a send that starts its chat");
            Ok(())
        },
    )
    .await
}

/// A message to a Claude Code agent whose turn waits goes to the send queue,
/// as for any busy agent (docs/Local-Engine-Turns.md 11.7), and once that
/// turn ends the drain sends it as its person's, to the same agent: a turn
/// that waits for their computer in its turn.
#[tokio::test]
async fn a_message_to_a_claude_code_agent_whose_turn_waits_is_queued_and_drained_after_it(
) -> anyhow::Result<()> {
    with_lane(
        "lane-queue",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (chat, waiting) = lane.lane_turn().await?;
            let before = lane.written().await?;
            let (status, response) = lane
                .send(
                    &lane.owner(),
                    chat,
                    &with(
                        lane_send(lane_metadata(json!({}))),
                        json!({ "expectedLaneIdle": true }),
                    ),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            assert_eq!(response["status"], json!("queued"), "{response}");
            let after = lane.written().await?;
            assert_eq!((after.queued, after.jobs), (before.queued + 1, before.jobs));
            let entry: Uuid = sql_one(
                lane.pool(),
                "select id from conversation_send_queue where conversation_id = $1",
                &[&chat],
            )
            .await?;

            // The waiting turn ends, and the drain sends the queued message.
            lane.end_job(waiting).await?;
            crate::send_queue::recover_send_queue_batch(&lane.harness.state, None)
                .await
                .map_err(|(status, error)| anyhow::anyhow!("drain: {status} {}", error.message))?;
            let run = eventually("the queued message to start a run", || async {
                sql_one::<Option<Uuid>>(
                    lane.pool(),
                    "select dispatched_run_id from conversation_send_queue where id = $1",
                    &[&entry],
                )
                .await
            })
            .await?;
            let drained: Uuid = sql_one(
                lane.pool(),
                "select id from agent_jobs where run_id = $1",
                &[&run],
            )
            .await?;
            assert_lane_job(
                &lane.job(drained).await?,
                space.owner,
                lane.owner_claude,
                "the drained message",
            );
            Ok(())
        },
    )
    .await
}

/// A turn that waits for its person's computer keeps only that person's own
/// agent busy in a shared chat: a teammate's send to their own @claude there
/// is admitted at once, never queued behind it (11.7).
#[tokio::test]
async fn a_waiting_lane_turn_keeps_no_teammates_agent_busy() -> anyhow::Result<()> {
    with_lane(
        "lane-waiting-busy",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (chat, _waiting) = lane.lane_turn().await?;
            let (status, response) = lane
                .send(
                    &lane.token(space.member),
                    chat,
                    &with(
                        lane_send(lane_metadata(json!({}))),
                        json!({ "expectedLaneIdle": true }),
                    ),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            assert_eq!(
                sql_one::<i64>(
                    lane.pool(),
                    "select count(*) from conversation_send_queue where conversation_id = $1",
                    &[&chat],
                )
                .await?,
                0,
                "the teammate's send was queued: {response}"
            );
            let job = Uuid::parse_str(response["jobId"].as_str().unwrap_or_default())?;
            assert_lane_job(
                &lane.job(job).await?,
                space.member,
                lane.member_claude,
                "the teammate's own turn",
            );
            Ok(())
        },
    )
    .await
}

/// A message that waits in the send queue behind its own person's waiting
/// Claude Code turn waits with it, and holds up nobody else (11.7): a
/// teammate's send to their own @claude is admitted at once, and the drain
/// leaves the parked message queued until its person's turn is no longer
/// waiting.
#[tokio::test]
async fn a_message_parked_behind_a_waiting_turn_holds_up_nobody_else() -> anyhow::Result<()> {
    with_lane(
        "lane-parked",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (chat, _waiting) = lane.lane_turn().await?;
            let parked_send = with(
                lane_send(lane_metadata(json!({}))),
                json!({ "expectedLaneIdle": true }),
            );
            let (status, response) = lane.send(&lane.owner(), chat, &parked_send).await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            assert_eq!(response["status"], json!("queued"), "{response}");
            let parked: Uuid = sql_one(
                lane.pool(),
                "select id from conversation_send_queue where conversation_id = $1",
                &[&chat],
            )
            .await?;

            let (status, response) = lane
                .send(
                    &lane.token(space.member),
                    chat,
                    &with(
                        lane_send(lane_metadata(json!({}))),
                        json!({ "expectedLaneIdle": true }),
                    ),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            let job = Uuid::parse_str(response["jobId"].as_str().unwrap_or_default())
                .map_err(|_| anyhow::anyhow!("the teammate's send was queued: {response}"))?;
            assert_lane_job(
                &lane.job(job).await?,
                space.member,
                lane.member_claude,
                "the teammate's own turn",
            );

            crate::send_queue::recover_send_queue_batch(&lane.harness.state, None)
                .await
                .map_err(|(status, error)| anyhow::anyhow!("drain: {status} {}", error.message))?;
            assert_eq!(
                sql_one::<String>(
                    lane.pool(),
                    "select status from conversation_send_queue where id = $1",
                    &[&parked],
                )
                .await?,
                "queued",
                "the parked message left the queue while its turn waited"
            );
            Ok(())
        },
    )
    .await
}

/// An automation an agent's job made never runs on Claude Code, even once
/// its agent moves there: its prompt is that agent's words (11.5). Its run is
/// refused with a reason, and no lane turn starts.
#[tokio::test]
async fn an_automation_an_agents_job_made_never_runs_on_claude_code() -> anyhow::Result<()> {
    with_lane(
        "lane-agent-made",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let codex_chat = lane.chat().await?;
            lane.admitted(codex_chat, &octo_send(space.runtime)).await?;
            let leased = lane.harness.lease(space.runtime).await?;
            let job_token = leased["controller_token"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("no job token: {leased}"))?
                .to_string();
            let (status, created) = lane
                .harness
                .call(
                    "POST",
                    format!("/projects/{}/automations", space.project_id),
                    Some(&job_token),
                    Some(json!({
                        "name": "Made by an agent",
                        "promptText": WORDS,
                        "scheduleKind": "hourly",
                        "intervalHours": 24,
                        "timezone": "UTC",
                        "runtimeMode": "auto",
                        "metadata": { "agentSelection": { "active": ["helper"], "mentions": ["helper"] } },
                    })),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "automation: {status} {created}");
            let automation = Uuid::parse_str(created["id"].as_str().unwrap_or_default())?;
            // Its agent moves to Claude Code.
            sql(
                lane.pool(),
                "update user_agents set provider = 'claude-code', credential_id = null
                  where id = $1",
                &[&space.owner_agent],
            )
            .await?;
            lane.run_automation(automation).await?;
            let (last_error, thread): (Option<String>, Option<Uuid>) = {
                let row = lane
                    .pool()
                    .get()
                    .await?
                    .query_one(
                        "select last_error, conversation_id from automations where id = $1",
                        &[&automation],
                    )
                    .await?;
                (row.get(0), row.get(1))
            };
            assert!(
                last_error
                    .as_deref()
                    .is_some_and(|error| error.contains("An agent made this automation")),
                "{last_error:?}"
            );
            if let Some(thread) = thread {
                assert!(lane.jobs_in(thread).await?.is_empty(), "a turn started");
            }
            // Its owner saves it, as Studio's editor does, with no metadata:
            // its words are theirs now, and it runs on Claude Code.
            let (status, response) = lane
                .harness
                .call(
                    "PATCH",
                    format!("/automations/{automation}"),
                    Some(&lane.owner()),
                    Some(json!({ "name": "Made by an agent, saved by its owner" })),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "save: {status} {response}");
            assert_eq!(
                sql_one::<Option<JsonValue>>(
                    lane.pool(),
                    "select metadata -> 'madeByAnAgentsJob' from automations where id = $1",
                    &[&automation],
                )
                .await?,
                None
            );
            Ok(())
        },
    )
    .await
}

/// A Claude Code agent's job holds no Instafy AI reserve (crate::credits):
/// in a send to it and to an agent on Instafy AI, the other's failure finds
/// nothing else holding the prompt's reserve, so it is given back.
#[tokio::test]
async fn a_lane_turn_never_holds_the_instafy_ai_reserve() -> anyhow::Result<()> {
    with_lane(
        "lane-reserve",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (chat, waiting) = lane.lane_turn().await?;
            let prompt: Uuid = sql_one(
                lane.pool(),
                "select prompt_id from agent_jobs where id = $1",
                &[&waiting],
            )
            .await?;
            let sibling = Uuid::new_v4();
            sql(
                lane.pool(),
                "insert into agent_jobs (id, project_id, conversation_id, prompt_id, intent,
                                         status, payload)
                 values ($1, $2, $3, $4, 'feature', 'failed', '{}'::jsonb)",
                &[&sibling, &space.project_id, &chat, &prompt],
            )
            .await?;
            let mut connection = lane.pool().get().await?;
            let transaction = connection.transaction().await?;
            let held = crate::credits::other_instafy_ai_turns_hold_reserve(
                &transaction,
                &space.project_id,
                &prompt,
                &sibling,
            )
            .await
            .map_err(|(status, Json(error))| anyhow::anyhow!("{status} {}", error.message))?;
            transaction.rollback().await?;
            assert!(!held, "the waiting lane turn held the Instafy AI reserve");
            Ok(())
        },
    )
    .await
}

/// A teammate's mention of @claude reaches the teammate's own @claude
/// (docs/Local-Engine-Turns.md 11.5): their turn, on their own Claude Code,
/// which only their own computer leases. Two people's turns wait and run
/// apart: the owner's runs on the owner's computer while the member's does.
#[tokio::test]
async fn a_teammates_mention_reaches_only_their_own_claude_code_agent() -> anyhow::Result<()> {
    with_lane(
        "lane-teammate",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            // In the owner's chat, the member mentions @claude.
            let chat = lane.chat().await?;
            let member_turn = lane
                .admitted_as(
                    &lane.token(space.member),
                    chat,
                    &lane_send(lane_metadata(json!({}))),
                )
                .await?;
            assert_lane_job(
                &lane.job(member_turn).await?,
                space.member,
                lane.member_claude,
                "the member's turn",
            );
            for computer in [lane.desktop, lane.second_desktop] {
                lane.leases_nothing(computer, "the owner's computer")
                    .await?;
            }
            lane.lease_one(lane.member_desktop, member_turn).await?;
            // The owner's own turn there runs on the owner's computer
            // meanwhile.
            let owner_turn = lane
                .admitted(chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            assert_lane_job(
                &lane.job(owner_turn).await?,
                space.owner,
                lane.owner_claude,
                "the owner's turn",
            );
            lane.leases_nothing(lane.member_desktop, "the member's computer")
                .await?;
            lane.lease_one(lane.desktop, owner_turn).await?;
            Ok(())
        },
    )
    .await
}

/// A send to a Claude Code agent and to an agent with a connection, without
/// write intent, makes two jobs (docs/Local-Engine-Turns.md 11.6), each
/// read-only: the lane one, with this agent's part of the message, no
/// connection and no runtime pin, and the other as it would be without it,
/// on its connection and the runtime the send named. Each run says its own
/// AI, and the person's message and prompt, which are not every target's,
/// carry no lane stamp.
#[tokio::test]
async fn a_send_to_a_claude_code_agent_and_another_runs_each_on_its_own_ai() -> anyhow::Result<()> {
    with_lane(
        "lane-mixed",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let before = lane.written().await?;
            let (status, response) = lane
                .send(
                    &lane.owner(),
                    chat,
                    &json!({
                        "promptText": WORDS,
                        "intent": "feature",
                        "runtimeId": space.runtime.to_string(),
                        "metadata": metadata_for(&[CLAUDE, "helper"], json!({
                            "writeIntent": false,
                            "agentPromptSegments": {
                                "claude": "Fix the build.",
                                "helper": "Review the docs.",
                            },
                        })),
                    }),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            let (lane_jobs, other_jobs) = lane.jobs_of(&response).await?;
            assert_eq!((lane_jobs.len(), other_jobs.len()), (1, 1), "{response}");
            let (claude, helper) = (&lane_jobs[0], &other_jobs[0]);
            assert_lane_job(claude, space.owner, lane.owner_claude, "@claude's job");
            assert_eq!(claude.payload["prompt_text"], json!("Fix the build."));
            for job in [claude, helper] {
                assert_eq!(job.payload["writeIntent"], json!(false), "{}", job.payload);
                assert_eq!(
                    job.payload["metadata"]["writeScope"]["mode"],
                    json!("read_only"),
                    "{}",
                    job.payload
                );
            }
            assert_eq!(helper.engine, None);
            assert_eq!(helper.credential_id, Some(lane.owner_credential));
            assert_eq!(helper.target_runtime_id, Some(space.runtime));
            assert_eq!(helper.payload["prompt_text"], json!("Review the docs."));
            assert_eq!(helper.payload["metadata"]["aiAccessMode"], json!("byoc"));
            assert_never_holds(&helper.payload, &["claudeCode"], "@helper's job");

            let run_of = |job: &Job| job.run_id.expect("run");
            let claude_run = lane
                .metadata_of("select metadata from runs where id = $1", run_of(claude))
                .await?;
            assert_lane_stamps(&claude_run, "@claude's run");
            let helper_run = lane
                .metadata_of("select metadata from runs where id = $1", run_of(helper))
                .await?;
            assert_eq!(helper_run["aiAccessMode"], json!("byoc"), "{helper_run}");
            assert!(helper_run.get("claudeCode").is_none(), "{helper_run}");
            for (what, query) in [
                (
                    "the message",
                    "select m.metadata from conversation_messages m
                      join runs r on r.prompt_id = (select prompt_id from runs where id = $1)
                     where m.run_id = r.id and m.role = 'user' limit 1",
                ),
                (
                    "the prompt",
                    "select p.metadata from prompts p join runs r on r.prompt_id = p.id
                      where r.id = $1",
                ),
            ] {
                let metadata = lane.metadata_of(query, run_of(claude)).await?;
                assert!(metadata.get("claudeCode").is_none(), "{what}: {metadata}");
            }
            assert_eq!(
                lane.written().await?,
                Written {
                    prompts: before.prompts + 1,
                    runs: before.runs + 2,
                    messages: before.messages + 1,
                    jobs: before.jobs + 2,
                    ..before
                }
            );
            Ok(())
        },
    )
    .await
}

/// An ambient evaluation asks an agent whether to join in now, so it never
/// waits (docs/Local-Engine-Turns.md 11.7): in a group chat, an un-addressed
/// message to a Claude Code agent none of whose person's computers in the
/// space could take it closes its run as canceled, marked
/// `claudeCodeSkipped: {"reason": "computer_away"}`, with no job. With one of
/// them ready, it is a lane turn that carries the evaluation's instruction in
/// front of the message, and its marker.
#[tokio::test]
async fn an_ambient_evaluation_sits_out_while_no_computer_of_its_persons_is_ready(
) -> anyhow::Result<()> {
    with_lane(
        "lane-evaluation",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let ambient = || {
                lane_send(lane_metadata(json!({
                    "agentSelection": { "active": [CLAUDE], "mentions": [] },
                })))
            };
            // The owner's computers are up, without Claude Code ready; the
            // member's is ready.
            for computer in [lane.desktop, lane.second_desktop] {
                lane.set_capabilities(computer, capabilities(Some(space.owner), lane_not_ready()))
                    .await?;
            }
            let chat = lane.chat().await?;
            let before = lane.written().await?;
            let (status, response) = lane.send(&lane.owner(), chat, &ambient()).await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            let run = Uuid::parse_str(response["runId"].as_str().unwrap_or_default())
                .map_err(|_| anyhow::anyhow!("no run: {response}"))?;
            assert_eq!(lane.run_status(run).await?, "canceled");
            let run_metadata = lane
                .metadata_of("select metadata from runs where id = $1", run)
                .await?;
            assert_eq!(
                run_metadata[claude_code_lane::SKIPPED_KEY],
                json!({ "reason": "computer_away" }),
                "{run_metadata}"
            );
            assert_lane_stamps(&run_metadata, "the skipped run");
            assert_eq!(
                lane.written().await?,
                Written {
                    prompts: before.prompts + 1,
                    runs: before.runs + 1,
                    messages: before.messages + 1,
                    ..before
                },
                "the message and a closed run, and no job"
            );

            // With one of the owner's computers ready, it is a lane turn.
            lane.set_capabilities(lane.desktop, capabilities(Some(space.owner), lane_ready()))
                .await?;
            let chat = lane.chat().await?;
            let job = lane.job(lane.admitted(chat, &ambient()).await?).await?;
            assert_lane_job(&job, space.owner, lane.owner_claude, "the evaluation");
            assert!(
                crate::group_participation::job_payload_marks_agent_evaluation(&job.payload),
                "{}",
                job.payload
            );
            let prompt = job.payload["prompt_text"].as_str().unwrap_or_default();
            assert!(
                prompt != WORDS && prompt.ends_with(&format!("\n\n{WORDS}")),
                "the instruction in front of the message: {prompt}"
            );
            let content: String = sql_one(
                lane.pool(),
                "select content from conversation_messages where run_id = $1 and role = 'user'",
                &[&job.run_id.expect("run")],
            )
            .await?;
            assert_eq!(content, WORDS, "the message keeps its own words");
            Ok(())
        },
    )
    .await
}

/// Lease (docs/Local-Engine-Turns.md 11.7): a waiting lane turn is leased
/// only by a computer in its space that is private self-hosted, attested as
/// its person's own, with a ready `claudeCode` of version 1: never a hosted
/// runtime that reports the capability, even pinned to it, a teammate's or a
/// service-owned computer, a Personal Browser runtime, or the person's own
/// computer without the capability. The lease adds no envelope, metering
/// bind, job token, history or extras, keeps the internal workspace token,
/// and is the turn's only one.
#[tokio::test]
async fn only_a_ready_computer_of_its_persons_own_leases_a_lane_turn_once() -> anyhow::Result<()> {
    with_lane(
        "lane-lease",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (_, job) = lane.lane_turn().await?;
            let hosted = lane
                .computer(
                    "instafy-cloud",
                    capabilities(None, lane_ready()),
                    "ready",
                    600,
                )
                .await?;
            let service_owned = lane
                .computer(
                    "self-hosted",
                    capabilities(Some(lane.service_user), lane_ready()),
                    "ready",
                    600,
                )
                .await?;
            let personal_browser = lane
                .computer(
                    "self-hosted",
                    capabilities(
                        Some(space.owner),
                        with(
                            lane_ready(),
                            json!({ "personalBrowser": {
                                "enabled": true,
                                "ownerUserId": space.owner.to_string(),
                            } }),
                        ),
                    ),
                    "ready",
                    600,
                )
                .await?;
            for runtime in [
                hosted,
                service_owned,
                lane.member_desktop,
                personal_browser,
                space.runtime,
            ] {
                lane.leases_nothing(runtime, "another computer").await?;
            }
            // Pinned to any of them, none leases it either: the lease's own
            // clause keeps them out, a hosted runtime's included.
            for runtime in [hosted, lane.member_desktop, personal_browser, space.runtime] {
                lane.pin(job, Some(runtime)).await?;
                lane.leases_nothing(runtime, "pinned there").await?;
            }
            lane.pin(job, None).await?;
            // Nor does the person's own computer while it attests no ready
            // capability of version 1, or another owner.
            for (what, attested) in [
                (
                    "not ready",
                    capabilities(Some(space.owner), lane_not_ready()),
                ),
                (
                    "another version",
                    capabilities(
                        Some(space.owner),
                        json!({ "claudeCode": { "version": 2, "ready": true } }),
                    ),
                ),
                ("no capability", capabilities(Some(space.owner), json!({}))),
                (
                    "another owner",
                    capabilities(Some(space.member), lane_ready()),
                ),
            ] {
                lane.set_capabilities(lane.desktop, attested).await?;
                lane.leases_nothing(lane.desktop, what).await?;
            }
            lane.set_capabilities(lane.desktop, capabilities(Some(space.owner), lane_ready()))
                .await?;

            let leased = lane.lease_one(lane.desktop, job).await?;
            assert_eq!(leased["engine"], json!("claude-code"), "{leased}");
            assert_eq!(leased["lease_attempts"], json!(1), "{leased}");
            for key in [
                "proxy",
                "controller_token",
                "controller_token_expires_at",
                "controller_token_scopes",
                "grants",
                "grant_token",
                "credential_id",
            ] {
                assert!(leased.get(key).is_none(), "{key}: {leased}");
            }
            assert!(
                leased["workspace_token"]
                    .as_str()
                    .is_some_and(|token| !token.is_empty()),
                "{leased}"
            );
            let scopes = leased["workspace_token_scopes"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for scope in [
                crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE,
                crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE,
            ] {
                assert!(scopes.contains(&json!(scope)), "{scope}: {leased}");
            }
            let payload = &leased["payload"];
            assert_eq!(payload["prompt_text"], json!(WORDS));
            for key in [
                "conversation_history",
                "skill_setup_openers",
                crate::browser_hand_back::TURNS_SINCE_KEY,
                crate::browser_hand_back::READS_NOTE_KEY,
                "space_pages",
                "attachment_downloads",
            ] {
                assert!(payload.get(key).is_none(), "{key}: {payload}");
            }
            let platform_records: i64 = sql_one(
                lane.pool(),
                "select count(*) from ai_usage_jobs where job_id = $1",
                &[&job],
            )
            .await?;
            assert_eq!(platform_records, 0, "no metering bind");

            // Leased once: put back in the queue, no computer of the person's
            // leases it again.
            lane.put_back(job).await?;
            for computer in [lane.desktop, lane.second_desktop] {
                lane.leases_nothing(computer, "leased once").await?;
            }
            Ok(())
        },
    )
    .await
}

/// One lane turn runs at a time for each person, on any of their computers
/// (docs/Local-Engine-Turns.md 11.7, 11.8): while one of the owner's turns
/// runs on their second computer, neither computer leases their next, and
/// the index refuses a second running one; another person's turn runs
/// meanwhile; and once the first ends, the other computer takes the next.
#[tokio::test]
async fn one_lane_turn_runs_at_a_time_for_each_person_on_any_of_their_computers(
) -> anyhow::Result<()> {
    with_lane(
        "lane-one-running",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (_, first) = lane.lane_turn().await?;
            let (_, next) = lane.lane_turn().await?;
            // Either computer of the person's takes their oldest waiting turn.
            lane.lease_one(lane.second_desktop, first).await?;
            for computer in [lane.desktop, lane.second_desktop] {
                lane.leases_nothing(computer, "one runs at a time").await?;
            }
            assert_eq!(lane.job(next).await?.status, "queued");
            // The index agrees: a second running turn of the person's fails.
            let refused = sql(
                lane.pool(),
                "update agent_jobs set status = 'leased', lease_attempts = 1,
                        leased_by_runtime_id = $2, leased_at = now(),
                        lease_expires_at = now() + interval '2 minutes'
                  where id = $1",
                &[&next, &lane.desktop],
            )
            .await
            .expect_err("a second running turn");
            let refused = refused
                .downcast_ref::<tokio_postgres::Error>()
                .expect("a database error");
            assert!(
                claude_code_lane::is_second_running_turn(refused),
                "{refused}"
            );
            // Another person's turn runs meanwhile.
            let member_turn = lane
                .admitted_as(
                    &lane.token(space.member),
                    lane.chat().await?,
                    &lane_send(lane_metadata(json!({}))),
                )
                .await?;
            lane.lease_one(lane.member_desktop, member_turn).await?;
            // The first ends: the other computer takes the next.
            lane.harness
                .complete(
                    lane.second_desktop,
                    first,
                    json!({ "outcome": "succeeded", "summary": "Fixed the build." }),
                )
                .await?;
            lane.lease_one(lane.desktop, next).await?;
            Ok(())
        },
    )
    .await
}

/// A lane turn waits for its person's computer however long
/// (docs/Local-Engine-Turns.md 11.7): sent while none of their computers can
/// take it, it is admitted, and past the minute a granted turn has to start
/// and the stranded-platform grace, no sweep fails it; once a computer of
/// theirs is back, it takes the turn.
#[tokio::test]
async fn a_lane_turn_waits_for_its_persons_computer_however_long() -> anyhow::Result<()> {
    with_lane(
        "lane-waits",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            // One of the owner's computers is off, and the other's Claude
            // Code is not ready.
            sql(
                lane.pool(),
                "update runtimes set status = 'stopped' where id = $1",
                &[&lane.desktop],
            )
            .await?;
            lane.set_capabilities(
                lane.second_desktop,
                capabilities(Some(space.owner), lane_not_ready()),
            )
            .await?;
            let (_, job) = lane.lane_turn().await?;
            lane.leases_nothing(lane.second_desktop, "not ready")
                .await?;
            sql(
                lane.pool(),
                "update agent_jobs
                    set created_at = now() - interval '3 days',
                        trigger_received_at = now() - interval '3 days'
                  where id = $1",
                &[&job],
            )
            .await?;
            lane.sweep_while_active().await?;
            let waiting = lane.job(job).await?;
            assert_eq!(
                (waiting.status.as_str(), waiting.lease_attempts),
                ("queued", 0)
            );
            assert_eq!(
                lane.run_status(waiting.run_id.expect("run")).await?,
                "queued"
            );
            // Its computer is back.
            lane.lease_one(lane.desktop, job).await?;
            Ok(())
        },
    )
    .await
}

/// A computer takes the work pinned to it before a lane turn that waits for
/// any of its person's computers (version 1's "lane turn first" is gone), and
/// a lane turn is never batched: it is leased alone, and no batch's
/// continuation takes it, not even one of a team's plan in its own chat.
#[tokio::test]
async fn a_lane_turn_waits_behind_its_computers_pinned_work_and_is_never_batched(
) -> anyhow::Result<()> {
    with_lane(
        "lane-batch",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (_, job) = lane.lane_turn().await?;
            // Work pinned to the same computer: a read-only job of a team's
            // plan, whose batch would take its plan's read-only jobs, and an
            // ordinary one.
            let other_chat = lane.chat().await?;
            let group = Uuid::new_v4().to_string();
            let plan_job = lane
                .queue_codex_job(
                    lane.desktop,
                    other_chat,
                    0,
                    json!({
                        "writeScope": { "mode": "read_only" },
                        "multiAgentPlan": { "groupId": group },
                    }),
                )
                .await?;
            let ordinary = lane
                .queue_codex_job(lane.desktop, other_chat, 1, json!({}))
                .await?;
            lane.lease_one(lane.desktop, plan_job).await?;
            lane.lease_one(lane.desktop, ordinary).await?;
            lane.lease_one(lane.desktop, job).await?;

            // No batch's continuation takes a lane turn, not even one of a
            // team's plan in the turn's own chat.
            lane.end_jobs().await?;
            let (chat_of_next, next) = lane.lane_turn().await?;
            {
                let mut connection = lane.pool().get().await?;
                let transaction = connection.transaction().await?;
                let continued = crate::agent::lease_next_agent_job(
                    &transaction,
                    &space.project_id,
                    Some(&lane.desktop),
                    120,
                    true,
                    false,
                    false,
                    true,
                    Some(&chat_of_next),
                    Some(group.as_str()),
                    true,
                )
                .await
                .map_err(|(status, error)| anyhow::anyhow!("lease: {status} {}", error.message))?;
                assert!(
                    continued.is_none(),
                    "a continuation leased {:?}",
                    continued.map(|job| job.id)
                );
                transaction.rollback().await?;
            }
            lane.lease_one(lane.desktop, next).await?;
            Ok(())
        },
    )
    .await
}

/// An expired lane lease, in a space that is still active, is never renewed
/// or leased again: a heartbeat on it gets a 409, and the 10 s sweep fails
/// the turn as `run_once_interrupted`, with the message its person's Studio
/// words.
#[tokio::test]
async fn an_expired_lane_lease_ends_its_turn_for_good() -> anyhow::Result<()> {
    with_lane(
        "lane-expired-lease",
        |_, _| {},
        |lane| async move {
            let (_, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let heartbeat = || {
                lane.agent_call(
                    lane.desktop,
                    "/agent/heartbeat",
                    json!({ "job_id": job, "extend_seconds": 60 }),
                )
            };
            let (status, body) = heartbeat().await?;
            assert_eq!(status, StatusCode::OK, "a live lease: {body}");
            sql(
                lane.pool(),
                "update agent_jobs set lease_expires_at = now() - interval '1 second'
                  where id = $1",
                &[&job],
            )
            .await?;
            let (status, body) = heartbeat().await?;
            assert_eq!(status, StatusCode::CONFLICT, "an expired lease: {body}");
            assert_eq!(lane.job(job).await?.status, "leased");

            lane.sweep_while_active().await?;
            let (status, error, _) = lane.ended(job).await?;
            assert_eq!(status, "failed");
            assert!(
                error
                    .as_deref()
                    .is_some_and(|error| error.contains("may run only once")),
                "{error:?}"
            );
            let run = lane.job(job).await?.run_id.expect("run");
            assert_eq!(lane.run_status(run).await?, "failed");
            let (_, metadata) = lane.failure_message(run).await?;
            assert_eq!(metadata["kind"], json!("run_once_interrupted"));
            assert_lane_failure(&metadata, "run_once_interrupted", "an expired lease");
            for computer in [lane.desktop, lane.second_desktop] {
                lane.leases_nothing(computer, "an ended turn").await?;
            }
            Ok(())
        },
    )
    .await
}

/// The run-once sweep fails a lane turn put back in the queue after a lease
/// as `run_once_interrupted`, with the message its person's Studio words, and
/// leaves the turn that waits behind it, never leased, however old; that one
/// then runs.
#[tokio::test]
async fn the_run_once_sweep_fails_a_lane_turn_put_back_after_a_lease() -> anyhow::Result<()> {
    with_lane(
        "lane-run-once-sweep",
        |_, _| {},
        |lane| async move {
            let (_, interrupted) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, interrupted).await?;
            lane.put_back(interrupted).await?;
            let (_, waiting) = lane.lane_turn().await?;
            sql(
                lane.pool(),
                "update agent_jobs set trigger_received_at = now() - interval '2 hours'
                  where id = $1",
                &[&waiting],
            )
            .await?;

            lane.sweep_while_active().await?;
            let (status, error, _) = lane.ended(interrupted).await?;
            assert_eq!(status, "failed");
            assert!(
                error
                    .as_deref()
                    .is_some_and(|error| error.contains("may run only once")),
                "{error:?}"
            );
            let run = lane.job(interrupted).await?.run_id.expect("run");
            assert_eq!(lane.run_status(run).await?, "failed");
            let (_, metadata) = lane.failure_message(run).await?;
            assert_eq!(metadata["kind"], json!("run_once_interrupted"));
            assert_lane_failure(&metadata, "run_once_interrupted", "put back after a lease");

            assert_eq!(lane.job(waiting).await?.status, "queued");
            lane.lease_one(lane.desktop, waiting).await?;
            Ok(())
        },
    )
    .await
}

/// A runtime stop fails the lane turn that runtime leased as
/// `claude_code_machine_stopped` (docs/Local-Engine-Turns.md 11.7): its run
/// fails and its message carries what its person's Studio words it by. A
/// waiting turn has no pin and keeps waiting, whichever computer stops, and
/// the person's other computer takes it. The stop requeues the computer's
/// other work as before, and fails a lane turn still pinned to it, which
/// version 2 never queues.
#[tokio::test]
async fn a_runtime_stop_fails_the_lane_turn_it_leased_and_leaves_waiting_ones_queued(
) -> anyhow::Result<()> {
    with_lane(
        "lane-runtime-stop",
        |_, _| {},
        |lane| async move {
            let (_, first) = lane.lane_turn().await?;
            let codex_chat = lane.chat().await?;
            let codex = lane.admitted(codex_chat, &octo_send(lane.desktop)).await?;
            let (requeued, failed) = lane.stop_runtime(lane.desktop).await?;
            assert_eq!(requeued, vec![codex]);
            assert!(failed.is_empty(), "a waiting turn: {failed:?}");
            let waiting = lane.job(first).await?;
            assert_eq!(
                (
                    waiting.status.as_str(),
                    waiting.target_runtime_id,
                    waiting.lease_attempts
                ),
                ("queued", None, 0)
            );
            lane.end_job(codex).await?;

            // Leased, it fails; the person's next turn keeps waiting.
            lane.lease_one(lane.desktop, first).await?;
            let (_, next) = lane.lane_turn().await?;
            let (requeued, failed) = lane.stop_runtime(lane.desktop).await?;
            assert!(requeued.is_empty(), "{requeued:?}");
            assert_eq!(failed, vec![(first, true)], "failed with a message");
            let (status, error, _) = lane.ended(first).await?;
            assert_eq!(status, "failed");
            assert_eq!(
                error.as_deref(),
                Some(claude_code_lane::MACHINE_STOPPED_MESSAGE)
            );
            let run = lane.job(first).await?.run_id.expect("run");
            assert_eq!(lane.run_status(run).await?, "failed");
            let (content, metadata) = lane.failure_message(run).await?;
            assert_eq!(content, claude_code_lane::MACHINE_STOPPED_MESSAGE);
            assert_eq!(metadata["kind"], json!(claude_code_lane::MACHINE_STOPPED));
            assert_lane_failure(&metadata, claude_code_lane::MACHINE_STOPPED, "leased");
            let next_job = lane.job(next).await?;
            assert_eq!(
                (next_job.status.as_str(), next_job.target_runtime_id),
                ("queued", None)
            );
            lane.lease_one(lane.second_desktop, next).await?;

            // One still pinned to the stopped computer fails too.
            let (_, pinned) = lane.lane_turn().await?;
            lane.pin(pinned, Some(lane.desktop)).await?;
            let (_, failed) = lane.stop_runtime(lane.desktop).await?;
            assert_eq!(failed, vec![(pinned, true)]);
            assert_eq!(lane.job(next).await?.status, "leased", "another computer's");
            Ok(())
        },
    )
    .await
}

/// A runtime stop never waits on its lane turn's chat while it holds the
/// computer's row: a dispatch into that chat holds the chat's row
/// (`ensure_conversation_record`) while it waits for the computer's
/// (`ensure_runtime_target_owner`), so the two would deadlock. The stop's
/// transaction fails only the turn's job. The turn's run, Home row and
/// failure message, which all lock the chat's row (the run's end through the
/// notification trigger at its commit), are written once the stop has
/// committed, holding no runtime: the run's end before the message, so
/// everyone in the chat hears of the failure once, from the run's end.
/// Written again, they record nothing twice.
#[tokio::test]
async fn a_runtime_stop_never_waits_on_its_lane_turns_chat() -> anyhow::Result<()> {
    with_lane(
        "lane-stop-lock-order",
        |_, _| {},
        |lane| async move {
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            let wait = std::time::Duration::from_secs(10);

            // A dispatch into the turn's chat holds the chat's row.
            let mut dispatch_connection = lane.pool().get().await?;
            let dispatch = dispatch_connection.transaction().await?;
            dispatch
                .query_one(
                    "select id from conversations where id = $1 for update",
                    &[&chat],
                )
                .await?;
            // The stop commits without waiting on it.
            let (requeued, turns) =
                tokio::time::timeout(wait, lane.stop_runtime_only(lane.desktop))
                    .await
                    .map_err(|_| anyhow::anyhow!("the stop waited on its turn's chat"))??;
            assert!(requeued.is_empty(), "{requeued:?}");
            assert_eq!(
                turns.iter().map(|turn| turn.job_id).collect::<Vec<_>>(),
                vec![job]
            );
            assert_eq!(lane.job(job).await?.status, "failed");
            assert_eq!(lane.run_status(run).await?, "in_progress", "not yet");
            // The turn's end waits for the chat, holding nothing the dispatch
            // needs: the dispatch takes the computer's row next, and commits.
            let recorder = {
                let state = lane.harness.state.clone();
                let turn = turns[0].clone();
                crate::tests::spawn_aborting(async move {
                    crate::runtime::record_failed_claude_code_turn(&state, &turn)
                        .await
                        .map_err(|(status, error)| {
                            anyhow::anyhow!("record: {status} {}", error.message)
                        })
                })
            };
            tokio::time::timeout(
                wait,
                dispatch.query_one(
                    "select id from runtimes where id = $1 for share",
                    &[&lane.desktop],
                ),
            )
            .await
            .map_err(|_| anyhow::anyhow!("the dispatch waited on the stopped computer"))??;
            dispatch.commit().await?;
            drop(dispatch_connection);
            let recorded = tokio::time::timeout(wait, recorder)
                .await
                .map_err(|_| anyhow::anyhow!("the turn's end never got the chat"))???;
            assert!(recorded.ended_run, "it ended the run");
            let message = recorded.message.expect("a failure message");
            assert_eq!(message.conversation_id, chat);
            assert_eq!(message.run_id, Some(run));
            assert_eq!(message.content, claude_code_lane::MACHINE_STOPPED_MESSAGE);
            assert_eq!(
                message.metadata["kind"],
                json!(claude_code_lane::MACHINE_STOPPED)
            );
            assert_lane_failure(
                &message.metadata,
                claude_code_lane::MACHINE_STOPPED,
                "the turn's end",
            );
            assert_eq!(lane.run_status(run).await?, "failed");
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            // The run's end notifies everyone in the chat once, and its
            // failure message no one again.
            lane.assert_failure_notified_once(chat, run, "the turn's end")
                .await?;

            // Written again, it records nothing twice.
            let again = lane.record_stopped_turn(&turns[0]).await?;
            assert!(again.message.is_none() && !again.ended_run, "{again:?}");
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            lane.assert_failure_notified_once(chat, run, "written again")
                .await?;
            Ok(())
        },
    )
    .await
}

/// Two writers of one stopped lane turn's end at once, the stop's own and the
/// idle sweep's repair (on this controller or another), write it once: the
/// second waits for the turn's chat until the first has committed, then finds
/// its failure message there and writes nothing.
#[tokio::test]
async fn two_writers_of_a_stopped_lane_turns_end_write_it_once() -> anyhow::Result<()> {
    with_lane(
        "lane-stop-two-writers",
        |_, _| {},
        |lane| async move {
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            let (_, turns) = lane.stop_runtime_only(lane.desktop).await?;
            let wait = std::time::Duration::from_secs(10);

            // Both start while another transaction holds the chat, so each is
            // under way before either commits.
            let mut holder_connection = lane.pool().get().await?;
            let holder = holder_connection.transaction().await?;
            holder
                .query_one(
                    "select id from conversations where id = $1 for update",
                    &[&chat],
                )
                .await?;
            let writers = [&turns[0], &turns[0]].map(|turn| {
                let state = lane.harness.state.clone();
                let turn = turn.clone();
                crate::tests::spawn_aborting(async move {
                    crate::runtime::record_failed_claude_code_turn(&state, &turn)
                        .await
                        .map_err(|(status, error)| {
                            anyhow::anyhow!("record: {status} {}", error.message)
                        })
                })
            });
            eventually("both writers to wait", || async {
                let waiting: i64 = sql_one(
                    lane.pool(),
                    "select count(*) from pg_stat_activity
                      where datname = current_database() and wait_event_type = 'Lock'",
                    &[],
                )
                .await?;
                Ok((waiting >= 2).then_some(()))
            })
            .await?;
            holder.commit().await?;
            drop(holder_connection);
            let mut wrote = Vec::new();
            for writer in writers {
                let recorded = tokio::time::timeout(wait, writer)
                    .await
                    .map_err(|_| anyhow::anyhow!("a writer never finished"))???;
                wrote.push((recorded.message.is_some(), recorded.ended_run));
            }
            wrote.sort_unstable();
            assert_eq!(wrote, vec![(false, false), (true, true)], "one wrote it");
            assert_eq!(lane.run_status(run).await?, "failed");
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            lane.assert_failure_notified_once(chat, run, "two writers")
                .await?;
            Ok(())
        },
    )
    .await
}

/// What a runtime stop publishes for a lane turn it failed: when the
/// computer's Instafy stops on its way out (`POST /runtime/stop`), the turn's
/// chat gets its failure message and its run's end, as
/// `claude_code_machine_stopped`, each once the stop has committed and the
/// turn's end is written (docs/Local-Engine-Turns.md 2.9, 5.5), and everyone
/// in the chat is notified of the failure once.
#[tokio::test]
async fn a_runtime_stop_publishes_its_lane_turns_failure() -> anyhow::Result<()> {
    with_lane(
        "lane-stop-publish",
        |_, _| {},
        |lane| async move {
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            let mut events = lane.harness.state.events.subscribe();
            let (status, body) = lane
                .agent_call(
                    lane.desktop,
                    "/runtime/stop",
                    json!({ "runtime_id": lane.desktop, "reason": "agent_shutdown" }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");

            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            let (mut message, mut ended) = (None, None);
            while message.is_none() || ended.is_none() {
                let event = tokio::time::timeout_at(deadline, events.recv())
                    .await
                    .map_err(|_| {
                        anyhow::anyhow!("timed out: message {message:?}, run's end {ended:?}")
                    })??;
                match event.kind.as_str() {
                    "conversation.message_created"
                        if event.conversation_id == Some(chat)
                            && event.data["metadata"]["kind"]
                                == json!(claude_code_lane::MACHINE_STOPPED) =>
                    {
                        // The stop committed, and the turn's end is written.
                        assert_eq!(lane.job(job).await?.status, "failed");
                        assert_eq!(lane.run_status(run).await?, "failed");
                        message = Some(event.data);
                    }
                    "run.completed" if event.run_id == Some(run) => {
                        assert_eq!(lane.job(job).await?.status, "failed");
                        assert_eq!(lane.run_status(run).await?, "failed");
                        ended = Some(event.data);
                    }
                    _ => {}
                }
            }
            let (message, ended) = (message.expect("message"), ended.expect("run's end"));
            assert_eq!(
                message["content"],
                json!(claude_code_lane::MACHINE_STOPPED_MESSAGE)
            );
            assert_eq!(message["runId"], json!(run));
            assert_lane_failure(
                &message["metadata"],
                claude_code_lane::MACHINE_STOPPED,
                "the message event",
            );
            assert_eq!(ended["finalStatus"], json!("failed"));
            assert_eq!(
                ended["failureCode"],
                json!(claude_code_lane::MACHINE_STOPPED)
            );
            assert_eq!(
                ended["errorMessage"],
                json!(claude_code_lane::MACHINE_STOPPED_MESSAGE)
            );
            lane.assert_failure_notified_once(chat, run, "a stop of the computer")
                .await?;
            Ok(())
        },
    )
    .await
}

/// A runtime stop's own write of its lane turn's end may never commit: the
/// controller exits first, or the database refuses every try. Its last try
/// then publishes nothing, so no Studio shows an end that a reload would not,
/// and the turn stays as the stop left it. Once that write's grace has
/// passed, the idle sweep writes the end and publishes it: the run fails,
/// with one Home row and one `run.failed` notification, and its failure
/// message notifies no one again. Inside the grace the sweep leaves the turn
/// to its stop's write, and a second sweep writes nothing twice.
#[tokio::test]
async fn the_idle_sweep_writes_a_stopped_lane_turns_end_its_stop_never_wrote() -> anyhow::Result<()>
{
    with_lane(
        "lane-stop-repair",
        |_, _| {},
        |lane| async move {
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            let (_, turns) = lane.stop_runtime_only(lane.desktop).await?;
            assert_eq!(
                turns.iter().map(|turn| turn.job_id).collect::<Vec<_>>(),
                vec![job]
            );
            let mut events = lane.harness.state.events.subscribe();

            // Every try of the stop's own write fails (here its prompt is not
            // there): nothing is written, and nothing published.
            let refused = crate::runtime::FailedClaudeCodeTurn {
                prompt_id: Some(Uuid::new_v4()),
                ..turns[0].clone()
            };
            crate::runtime::finish_failed_claude_code_turn(&lane.harness.state, &refused).await;
            assert_eq!(lane.run_status(run).await?, "in_progress");
            assert_eq!(lane.stopped_turn_rows(run).await?, (0, 0));
            let published = stopped_turn_events(&mut events, chat, run);
            assert!(published.is_empty(), "{published:?}");

            // Inside the grace, the sweep leaves it to the stop's write.
            lane.sweep_while_active().await?;
            assert_eq!(
                lane.run_status(run).await?,
                "in_progress",
                "inside the grace"
            );

            // Past it, the sweep writes the turn's end, then publishes it.
            lane.stopped_ago(job, 61).await?;
            lane.sweep_while_active().await?;
            assert_eq!(lane.run_status(run).await?, "failed");
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            let (content, metadata) = lane.failure_message(run).await?;
            assert_eq!(content, claude_code_lane::MACHINE_STOPPED_MESSAGE);
            assert_eq!(metadata["jobId"], json!(job));
            assert_lane_failure(
                &metadata,
                claude_code_lane::MACHINE_STOPPED,
                "the sweep's write",
            );
            lane.assert_failure_notified_once(chat, run, "the sweep's write")
                .await?;
            let published = stopped_turn_events(&mut events, chat, run);
            assert_eq!(
                published
                    .iter()
                    .map(|(kind, _)| kind.as_str())
                    .collect::<Vec<_>>(),
                vec!["conversation.message_created", "run.completed"],
                "{published:?}"
            );
            assert_lane_failure(
                &published[0].1["metadata"],
                claude_code_lane::MACHINE_STOPPED,
                "the published message",
            );
            assert_eq!(published[1].1["finalStatus"], json!("failed"));
            assert_eq!(
                published[1].1["failureCode"],
                json!(claude_code_lane::MACHINE_STOPPED)
            );

            // A second sweep writes and publishes nothing more.
            lane.sweep_while_active().await?;
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            lane.assert_failure_notified_once(chat, run, "a second sweep")
                .await?;
            let published = stopped_turn_events(&mut events, chat, run);
            assert!(published.is_empty(), "{published:?}");
            Ok(())
        },
    )
    .await
}

/// The idle sweep writes the end of a stopped lane turn only while
/// local-engine turns are on for someone, and only for a turn stopped within
/// the last day: past either bound the turn keeps its unfinished run.
#[tokio::test]
async fn the_idle_sweep_leaves_a_stopped_lane_turn_with_the_lane_off_or_too_old(
) -> anyhow::Result<()> {
    with_lane(
        "lane-stop-repair-bounds",
        |_, _| {},
        |lane| async move {
            let (_, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            lane.stop_runtime_only(lane.desktop).await?;
            lane.stopped_ago(job, 61).await?;

            // A controller whose switch names nobody leaves it.
            let mut off = lane.harness.state.clone();
            off.config.claude_code_lane = ClaudeCodeLaneUsers(DeviceGrantUsers::Nobody);
            off.runtime_activity
                .mark_active(lane.space().project_id, Some(600), Some(Utc::now()))
                .await;
            crate::runtime::sweep_idle_activity(&off).await?;
            assert_eq!(lane.run_status(run).await?, "in_progress", "lane off");

            // So does one whose switch names someone, for a turn stopped more
            // than a day ago.
            lane.stopped_ago(job, 24 * 60 * 60 + 60).await?;
            lane.sweep_while_active().await?;
            assert_eq!(lane.run_status(run).await?, "in_progress", "too old");

            // Within the day, it writes the turn's end.
            lane.stopped_ago(job, 61).await?;
            lane.sweep_while_active().await?;
            assert_eq!(lane.run_status(run).await?, "failed");
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            Ok(())
        },
    )
    .await
}

/// Anyone who can write a chat can record an assistant message in it, and
/// every step of a lane turn shows them its `jobId`. A message recorded as the
/// end of a lane turn a runtime stop failed never stands in for the stop's own
/// ([`Lane::record_claims_of_a_stopped_turns_end`]): when the computer's
/// Instafy stops on its way out, the stop still fails the turn's run, writes
/// its stamped failure message once and publishes it and the run's end, and
/// everyone in the chat hears of the failure once (docs/Local-Engine-Turns.md
/// 2.9).
#[tokio::test]
async fn a_recorded_claim_of_a_stopped_lane_turns_end_never_stands_in_for_it() -> anyhow::Result<()>
{
    with_lane(
        "lane-stop-claimed-end",
        |_, _| {},
        |lane| async move {
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            lane.record_claims_of_a_stopped_turns_end(chat, job).await?;
            let mut events = lane.harness.state.events.subscribe();
            let (status, body) = lane
                .agent_call(
                    lane.desktop,
                    "/runtime/stop",
                    json!({ "runtime_id": lane.desktop, "reason": "agent_shutdown" }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");

            let mut published = Vec::new();
            eventually("the stopped turn's end to be published", || {
                published.extend(stopped_turn_events(&mut events, chat, run));
                let both = published.len() >= 2;
                async move { Ok(both.then_some(())) }
            })
            .await?;
            assert_eq!(
                published
                    .iter()
                    .map(|(kind, _)| kind.as_str())
                    .collect::<Vec<_>>(),
                vec!["conversation.message_created", "run.completed"],
                "{published:?}"
            );
            assert_eq!(published[0].1["createdBy"], JsonValue::Null);
            assert_eq!(published[0].1["runId"], json!(run));
            assert_lane_failure(
                &published[0].1["metadata"],
                claude_code_lane::MACHINE_STOPPED,
                "the published message",
            );
            assert_eq!(published[1].1["finalStatus"], json!("failed"));
            assert_eq!(
                published[1].1["failureCode"],
                json!(claude_code_lane::MACHINE_STOPPED)
            );
            assert_eq!(lane.job(job).await?.status, "failed");
            assert_eq!(lane.run_status(run).await?, "failed");
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            let (content, metadata) = lane.failure_message(run).await?;
            assert_eq!(content, claude_code_lane::MACHINE_STOPPED_MESSAGE);
            assert_eq!(metadata["jobId"], json!(job));
            assert_lane_failure(&metadata, claude_code_lane::MACHINE_STOPPED, "the stop's");
            lane.assert_failure_notified_once(chat, run, "a stop after a claim")
                .await?;
            Ok(())
        },
    )
    .await
}

/// The same for the idle sweep: a lane turn whose stop never wrote its end
/// gets it from the sweep, whatever message was recorded as that end first.
#[tokio::test]
async fn a_recorded_claim_of_a_stopped_lane_turns_end_never_stops_the_sweep_writing_it(
) -> anyhow::Result<()> {
    with_lane(
        "lane-stop-repair-claimed-end",
        |_, _| {},
        |lane| async move {
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            lane.record_claims_of_a_stopped_turns_end(chat, job).await?;
            // The stop commits, and its own write never runs.
            let (_, turns) = lane.stop_runtime_only(lane.desktop).await?;
            assert_eq!(
                turns.iter().map(|turn| turn.job_id).collect::<Vec<_>>(),
                vec![job]
            );
            let mut events = lane.harness.state.events.subscribe();

            lane.stopped_ago(job, 61).await?;
            lane.sweep_while_active().await?;
            assert_eq!(lane.run_status(run).await?, "failed");
            assert_eq!(lane.stopped_turn_rows(run).await?, (1, 1));
            let (content, metadata) = lane.failure_message(run).await?;
            assert_eq!(content, claude_code_lane::MACHINE_STOPPED_MESSAGE);
            assert_eq!(metadata["jobId"], json!(job));
            assert_lane_failure(
                &metadata,
                claude_code_lane::MACHINE_STOPPED,
                "the sweep's write",
            );
            let published = stopped_turn_events(&mut events, chat, run);
            assert_eq!(
                published
                    .iter()
                    .map(|(kind, _)| kind.as_str())
                    .collect::<Vec<_>>(),
                vec!["conversation.message_created", "run.completed"],
                "{published:?}"
            );
            assert_eq!(published[0].1["createdBy"], JsonValue::Null);
            assert_eq!(published[1].1["finalStatus"], json!("failed"));
            assert_eq!(
                published[1].1["failureCode"],
                json!(claude_code_lane::MACHINE_STOPPED)
            );
            lane.assert_failure_notified_once(chat, run, "the sweep after a claim")
                .await?;
            Ok(())
        },
    )
    .await
}

/// What says a stopped lane turn's end is already written is the controller's
/// own failure message alone: one nobody wrote, of the turn's run, with the
/// controller's lane stamp. A message with the turn's `jobId` and the stop's
/// kind that lacks any one of the three is not it, wherever it came from, and
/// the write still ends the run and records the message. Written again, it
/// records nothing twice.
#[tokio::test]
async fn only_the_controllers_own_message_is_a_stopped_lane_turns_end() -> anyhow::Result<()> {
    with_lane(
        "lane-stop-receipt",
        |_, _| {},
        |lane| async move {
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");
            let (_, turns) = lane.stop_runtime_only(lane.desktop).await?;
            let mut stamped = json!({
                "source": "controller",
                "kind": claude_code_lane::MACHINE_STOPPED,
                "outcome": "failed",
                "messageType": "error",
                "jobId": job,
                "runId": run,
            });
            claude_code_lane::stamp_failure(
                stamped.as_object_mut().expect("metadata"),
                claude_code_lane::MACHINE_STOPPED,
            );
            let unstamped = without(stamped.clone(), &["claudeCode"]);
            for (author, of_run, metadata) in [
                (Some(lane.space().member), Some(run), &stamped),
                (None, Some(run), &unstamped),
                (None, None, &stamped),
            ] {
                sql(
                    lane.pool(),
                    "insert into conversation_messages (
                         id, conversation_id, project_id, run_id, role, content, metadata,
                         created_by
                     ) values ($1, $2, $3, $4, 'assistant', $5, $6, $7)",
                    &[
                        &Uuid::new_v4(),
                        &chat,
                        &lane.space().project_id,
                        &of_run,
                        &claude_code_lane::MACHINE_STOPPED_MESSAGE,
                        &PgJson(metadata),
                        &author,
                    ],
                )
                .await?;
            }

            let recorded = lane.record_stopped_turn(&turns[0]).await?;
            assert!(recorded.ended_run, "it ended the run: {recorded:?}");
            let message = recorded.message.expect("a failure message");
            assert_eq!(message.created_by, None);
            assert_eq!(message.run_id, Some(run));
            assert_lane_failure(
                &message.metadata,
                claude_code_lane::MACHINE_STOPPED,
                "the turn's end",
            );
            assert_eq!(lane.run_status(run).await?, "failed");

            // Written again, it records nothing twice.
            let again = lane.record_stopped_turn(&turns[0]).await?;
            assert!(again.message.is_none() && !again.ended_run, "{again:?}");
            let own: i64 = sql_one(
                lane.pool(),
                "select count(*) from conversation_messages
                  where conversation_id = $1 and created_by is null and run_id = $2
                    and metadata ->> 'jobId' = $3 and metadata ? 'claudeCode'",
                &[&chat, &run, &job.to_string()],
            )
            .await?;
            assert_eq!(own, 1, "the controller's own failure messages");
            Ok(())
        },
    )
    .await
}

/// The paths that take a job with no credential for Instafy AI, or run a
/// failed turn again, ignore a lane turn: a short rate limit fails it rather
/// than put it back in the queue, and its end teaches the upstream pacing
/// nothing. (No sweep takes a waiting one for a stranded platform job either:
/// `a_lane_turn_waits_for_its_persons_computer_however_long`.)
#[tokio::test]
async fn platform_sweeps_retries_and_pacing_ignore_a_lane_turn() -> anyhow::Result<()> {
    with_lane(
        "lane-platform-paths",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (_, job) = lane.lane_turn().await?;
            // A short rate limit that puts a person's ordinary turn back in
            // the queue, and paces the platform's upstream, fails it.
            const RATE_LIMITED: &str = "rate limit exceeded: The upstream provider rate limit \
                 was reached (upstream_rate_limit, 429). Please try again in 7s.";
            assert!(crate::multi_agent_plan::short_rate_limit_wait(Some(RATE_LIMITED)).is_some());
            assert!(crate::upstream_pacing::rate_limit_cooldown(RATE_LIMITED).is_some());
            lane.lease_one(lane.desktop, job).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    job,
                    json!({ "outcome": "failed", "error_message": RATE_LIMITED }),
                )
                .await?;
            let ended = lane.job(job).await?;
            assert_eq!(ended.status, "failed");
            assert!(
                ended
                    .payload
                    .get(crate::turn_rate_limit_retry::PAYLOAD_KEY)
                    .is_none(),
                "{}",
                ended.payload
            );
            let paced: i64 = sql_one(
                lane.pool(),
                "select count(*) from upstream_pacing where upstream_key = $1",
                &[&crate::upstream_pacing::platform_project_key(
                    &space.project_id,
                )],
            )
            .await?;
            assert_eq!(paced, 0, "its end teaches the pacing nothing");
            Ok(())
        },
    )
    .await
}

/// A running lane turn takes no steer, its author's included, and gets no
/// secrets, proxy grant or job token. It starts no plan, question or browser
/// turn, while its own steps still post. Any member can still stop it.
#[tokio::test]
async fn a_lane_turn_takes_no_input_secrets_proxy_token_or_plan() -> anyhow::Result<()> {
    with_lane(
        "lane-refusals",
        |config, _| {
            config.credential_keys = Some(
                crate::config::CredentialEncryptionKey::for_test("lane-refusals-test-key").into(),
            );
        },
        |lane| async move {
            let space = lane.space();
            let (chat, job) = lane.lane_turn().await?;
            let leased = lane.lease_one(lane.desktop, job).await?;
            let run = lane.job(job).await?.run_id.expect("run");

            for user in [space.owner, space.member] {
                let (status, body) = lane
                    .harness
                    .call(
                        "POST",
                        format!("/conversations/{chat}/send-intents"),
                        Some(&lane.token(user)),
                        Some(json!({
                            "clientSendId": Uuid::new_v4().to_string(),
                            "mode": "steer",
                            "request": {
                                "promptText": "Also update the README.",
                                "intent": "feature",
                                "metadata": { "input": { "kind": "person" } },
                            },
                            "expectedActiveJobId": job,
                        })),
                    )
                    .await?;
                assert_eq!(
                    (status, body["code"].as_str()),
                    (
                        StatusCode::CONFLICT,
                        Some(claude_code_lane::TURN_TAKES_NO_INPUT)
                    ),
                    "{user}: {body}"
                );
            }

            let (status, body) = lane
                .agent_call(lane.desktop, "/agent/secrets", json!({ "job_id": job }))
                .await?;
            assert_eq!(
                (status, body["code"].as_str()),
                (
                    StatusCode::FORBIDDEN,
                    Some(claude_code_lane::TURN_TAKES_NO_SECRETS)
                ),
                "{body}"
            );
            let (status, body) = lane
                .agent_call(
                    lane.desktop,
                    format!("/agent/jobs/{job}/proxy-token"),
                    json!({ "lease_attempt": 1 }),
                )
                .await?;
            assert_eq!(
                (status, body["code"].as_str()),
                (
                    StatusCode::FORBIDDEN,
                    Some(claude_code_lane::TURN_HAS_NO_PROXY)
                ),
                "{body}"
            );
            // A job token for it, as the lease mints one for any other job.
            let token = crate::tokens::mint_scoped_token_with_runtime_generation(
                &lane.harness.state.config,
                crate::tokens::ScopedTokenRequest {
                    audience: lane.desktop.to_string(),
                    subject: space.owner.to_string(),
                    project_id: space.project_id.to_string(),
                    origin_id: None,
                    runtime_id: Some(lane.desktop.to_string()),
                    protocol: None,
                    scopes: vec![
                        crate::active_job_auth::ACTIVE_JOB_CONTROLLER_SCOPE.to_string(),
                        "fs.write".to_string(),
                    ],
                    lease_id: None,
                    run_id: Some(run.to_string()),
                    prefer_runtime: None,
                    ttl_seconds: None,
                },
                None,
            )
            .map_err(|(status, error)| anyhow::anyhow!("token: {status} {}", error.message))?
            .token;
            let (status, body) = lane
                .send(
                    &token,
                    chat,
                    &json!({
                        "promptText": "Start another turn.",
                        "intent": "feature",
                        "metadata": { "input": { "kind": "person" } },
                    }),
                )
                .await?;
            assert_eq!(
                (status, body["code"].as_str()),
                (
                    StatusCode::FORBIDDEN,
                    Some(claude_code_lane::TURN_HAS_NO_JOB_TOKEN)
                ),
                "{body}"
            );

            // Its messages that would start a turn are refused and recorded
            // nowhere; its own steps are not.
            let before = lane.messages_of_run(run).await?;
            for (message_type, metadata, reason) in [
                (
                    "multi_agent_plan",
                    json!({ "agents": [{ "handle": "helper", "prompt": "Review it." }] }),
                    "plan",
                ),
                (
                    "status",
                    json!({ "userInputRequestId": Uuid::new_v4().to_string() }),
                    "user_input_request",
                ),
                (
                    "status",
                    json!({ "browserBuildRequest": true }),
                    "hand_back",
                ),
                (
                    "action_request",
                    json!({ "browserRequest": { "task": "Open the docs." } }),
                    "action_request",
                ),
            ] {
                let (status, body) = lane
                    .agent_call(
                        lane.desktop,
                        "/agent/message",
                        json!({
                            "job_id": job,
                            "content": "Next.",
                            "message_type": message_type,
                            "metadata": metadata,
                        }),
                    )
                    .await?;
                assert_eq!(
                    (
                        status,
                        body["code"].as_str(),
                        body["details"]["reason"].as_str()
                    ),
                    (
                        StatusCode::FORBIDDEN,
                        Some(claude_code_lane::TURN_STARTS_NO_TURNS),
                        Some(reason)
                    ),
                    "{message_type}: {body}"
                );
            }
            assert_eq!(lane.messages_of_run(run).await?, before, "nothing recorded");
            let (status, body) = lane
                .agent_call(
                    lane.desktop,
                    "/agent/message",
                    json!({
                        "job_id": job,
                        "content": "Ran the tests.",
                        "message_type": "command_execution",
                        "metadata": { "event": { "type": "item.completed", "item": {
                            "type": "command_execution",
                            "command": "npm test",
                            "aggregated_output": "ok",
                            "exit_code": null,
                            "status": "completed",
                        } } },
                    }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(lane.messages_of_run(run).await?, before + 1);
            // A plan its message carried is refused by its job's column.
            let (status, Json(error)) =
                crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
                    &lane.harness.state,
                    &leased["payload"],
                    job,
                    Some(run),
                    &json!({ "messageType": "multi_agent_plan", "details": { "agents": [] } }),
                    "Plan.",
                    None,
                    None,
                )
                .await
                .expect_err("a lane parent plans nothing");
            assert_eq!(
                (status, error.code.as_deref()),
                (
                    StatusCode::FORBIDDEN,
                    Some(claude_code_lane::TURN_STARTS_NO_TURNS)
                )
            );

            // Any member can still stop it.
            let (status, body) = lane
                .harness
                .call(
                    "POST",
                    format!("/jobs/{job}/cancel"),
                    Some(&lane.token(space.member)),
                    Some(json!({})),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(lane.job(job).await?.status, "canceled");
            Ok(())
        },
    )
    .await
}

/// Only the computer that leased a lane turn ends it or posts to it
/// (docs/Local-Engine-Turns.md 2.4, 2.6), as for every job. Neither a token
/// with no runtime, which any member with write access can mint for the agent
/// routes, nor another runtime's of the space, a teammate's computer or the
/// person's own other one, completes, fails or posts to the turn, waiting or
/// leased: the token with no runtime is refused outright, another runtime is
/// answered as for a job it cannot find, and none writes a reply, usage row,
/// failure, conversation state or run change. The turn's own computer still
/// posts its steps and ends it.
#[tokio::test]
async fn only_the_computer_that_leased_a_lane_turn_ends_it_or_posts_to_it() -> anyhow::Result<()> {
    with_lane(
        "lane-foreign-completion",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (status, minted) = lane
                .harness
                .call(
                    "POST",
                    format!("/projects/{}/runtime/token", space.project_id),
                    Some(&lane.token(space.member)),
                    Some(json!({ "scopes": ["agent.complete", "agent.message"] })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            assert!(
                minted.get("runtime_id").is_none() && minted.get("runtimeId").is_none(),
                "a token with no runtime: {minted}"
            );
            let no_runtime = minted["token"].as_str().expect("a token").to_string();
            let teammates_computer = lane.harness.agent_token(lane.member_desktop).await?;
            let own_other_computer = lane.harness.agent_token(lane.second_desktop).await?;

            let (_, job) = lane.lane_turn().await?;
            let run = lane.job(job).await?.run_id.expect("run");
            let step = json!({
                "job_id": job,
                "content": "Ran the tests.",
                "message_type": "status",
                "metadata": { "text": "Ran the tests." },
            });
            let forged = [
                (
                    "/agent/complete",
                    json!({
                        "job_id": job,
                        "outcome": "succeeded",
                        "summary": "Someone else's words.",
                        "proxy_metadata": {
                            "provider": "claude-code",
                            "conversation": lane_session(lane.desktop, Uuid::new_v4()),
                        },
                        "artifacts": [{
                            "kind": "claude-code/usage",
                            "model": "claude-test-model",
                            "usage": { "input_tokens": 1, "output_tokens": 1 },
                        }],
                    }),
                ),
                (
                    "/agent/complete",
                    json!({
                        "job_id": job,
                        "outcome": "failed",
                        "error_message": "Claude Code isn't signed in.",
                        "proxy_metadata": { "conversation": {
                            "provider": "claude-code", "version": 1, "reset": true,
                        } },
                        "artifacts": [{ "kind": "claude-code/failure", "code": "not_signed_in" }],
                    }),
                ),
                ("/agent/message", step.clone()),
            ];
            let snapshot = || {
                let lane = &lane;
                async move {
                    anyhow::Ok((
                        lane.written().await?,
                        lane.ended(job).await?,
                        lane.run_status(run).await?,
                        lane.metadata_of("select metadata from runs where id = $1", run)
                            .await?,
                    ))
                }
            };
            for leased in [false, true] {
                if leased {
                    lane.lease_one(lane.desktop, job).await?;
                }
                let before = snapshot().await?;
                for (who, token, refusal) in [
                    ("no runtime", &no_runtime, StatusCode::UNAUTHORIZED),
                    (
                        "a teammate's computer",
                        &teammates_computer,
                        StatusCode::NOT_FOUND,
                    ),
                    (
                        "the person's other computer",
                        &own_other_computer,
                        StatusCode::NOT_FOUND,
                    ),
                ] {
                    for (path, body) in &forged {
                        let (status, response) = lane
                            .harness
                            .call("POST", *path, Some(token.as_str()), Some(body.clone()))
                            .await?;
                        assert_eq!(
                            status, refusal,
                            "{who}, {path}, leased {leased}: {response}"
                        );
                    }
                }
                assert_eq!(snapshot().await?, before, "leased {leased}");
                assert_eq!(
                    lane.job(job).await?.status,
                    if leased { "leased" } else { "queued" }
                );
            }

            // Its own computer posts its steps and ends it.
            let (status, body) = lane
                .agent_call(lane.desktop, "/agent/message", step)
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            lane.harness
                .complete(
                    lane.desktop,
                    job,
                    json!({ "outcome": "succeeded", "summary": "Fixed the build." }),
                )
                .await?;
            assert_eq!(lane.job(job).await?.status, "completed");
            Ok(())
        },
    )
    .await
}

/// The notes a lane turn's runtime posts under its reply (a save that kept
/// its changes on the computer, steps skipped for want of an OK) carry a
/// generic placement hint, `presentation: {"placement": "reply_note"}`, which
/// Studio places them by. The controller keeps the runtime's metadata under
/// `details` and keeps the hint there as the runtime sent it, for the turn's
/// author and a teammate alike.
#[tokio::test]
async fn a_lane_turns_notes_keep_their_placement_hint() -> anyhow::Result<()> {
    with_lane(
        "lane-reply-notes",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (chat, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            let hint = json!({ "placement": "reply_note" });
            let notes = [
                (
                    "Claude Code's changes stayed on this computer and weren't saved to the space.",
                    json!({
                        "kind": "claude_code_changes_not_saved",
                        "reason": "status_unreadable",
                        "presentation": hint,
                    }),
                ),
                (
                    "Claude Code skipped 2 steps that need your OK, since nobody can give it \
                     here. You can allow them in your own Claude Code settings.",
                    json!({
                        "kind": "claude_code_permission_denials",
                        "count": 2,
                        "presentation": hint,
                    }),
                ),
            ];
            for (content, details) in &notes {
                let (status, body) = lane
                    .agent_call(
                        lane.desktop,
                        "/agent/message",
                        json!({
                            "job_id": job,
                            "content": content,
                            "message_type": "status",
                            "metadata": details,
                        }),
                    )
                    .await?;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            let stored = lane
                .pool()
                .get()
                .await?
                .query(
                    "select content, metadata from conversation_messages
                      where conversation_id = $1 and metadata ->> 'messageType' = 'status'
                      order by created_at, id",
                    &[&chat],
                )
                .await?;
            assert_eq!(stored.len(), notes.len());
            // Every key the runtime sent is kept under `details` as it sent it,
            // beside the ones the controller adds there.
            for (row, (content, details)) in stored.iter().zip(&notes) {
                let metadata: JsonValue = row.get("metadata");
                assert_eq!(row.get::<_, String>("content"), *content);
                assert_eq!(metadata["source"], json!("agent"), "{metadata}");
                assert_eq!(metadata["messageType"], json!("status"), "{metadata}");
                for (key, value) in details.as_object().expect("details") {
                    assert_eq!(&metadata["details"][key], value, "{key}: {metadata}");
                }
            }
            for viewer in [space.owner, space.member] {
                let (status, page) = lane
                    .harness
                    .call(
                        "GET",
                        format!("/conversations/{chat}/messages"),
                        Some(&lane.token(viewer)),
                        None,
                    )
                    .await?;
                assert_eq!(status, StatusCode::OK, "{page}");
                let listed = page["messages"]
                    .as_array()
                    .expect("messages")
                    .iter()
                    .filter(|message| message["metadata"]["messageType"] == json!("status"))
                    .map(|message| message["metadata"]["details"]["presentation"].clone())
                    .collect::<Vec<_>>();
                assert_eq!(listed, vec![hint.clone(); notes.len()], "{viewer}: {page}");
            }
            Ok(())
        },
    )
    .await
}

/// A lane turn's completion keeps only what the lane writes: its provider is
/// `claude-code` whatever the runtime reports, a forged Codex run log is
/// dropped and bills nothing, what Claude Code reported it used is a
/// Details-only row with `billed: false`, a well-formed session is kept and a
/// malformed one dropped, and a failure's code is copied when Studio words
/// it. A Codex job that reports Claude Code's provider or state keeps
/// neither.
#[tokio::test]
async fn a_lane_turns_completion_keeps_only_what_the_lane_writes() -> anyhow::Result<()> {
    with_lane(
        "lane-completion",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let before = lane.written().await?;
            let session = Uuid::new_v4();
            let (_, job) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, job).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    job,
                    json!({
                        "outcome": "succeeded",
                        "summary": "Fixed the build; the tests pass.",
                        "proxy_metadata": {
                            "provider": "codex",
                            "conversation": lane_session(lane.desktop, session),
                        },
                        "artifacts": [
                            { "kind": "apply/files", "files": [] },
                            { "kind": "codex/run-log", "events": [{ "type": "turn.completed",
                                "usage": { "input_tokens": 9_000_000, "cached_input_tokens": 0,
                                           "output_tokens": 9_000_000 } }] },
                            { "kind": "claude-code/usage", "model": "claude-test-model",
                              "usage": { "input_tokens": 120, "cache_creation_input_tokens": 30,
                                         "cache_read_input_tokens": 850, "output_tokens": 40 } },
                        ],
                    }),
                )
                .await?;
            let (status, _, proxy_metadata) = lane.ended(job).await?;
            assert_eq!(status, "completed");
            assert_eq!(proxy_metadata["provider"], json!("claude-code"));
            assert_eq!(
                proxy_metadata["conversation"],
                lane_session(lane.desktop, session)
            );
            let run = lane.job(job).await?.run_id.expect("run");
            let run_metadata = lane
                .metadata_of("select metadata from runs where id = $1", run)
                .await?;
            assert_eq!(
                run_metadata["provider"]["id"],
                json!("claude-code"),
                "{run_metadata}"
            );
            let artifacts: JsonValue = sql_one(
                lane.pool(),
                "select artifacts from agent_jobs where id = $1",
                &[&job],
            )
            .await?;
            assert!(
                !artifacts.to_string().contains("codex/run-log"),
                "{artifacts}"
            );
            let after = lane.written().await?;
            assert_eq!(after.ledger, before.ledger, "no credit burned");
            assert_eq!(after.platform_jobs, before.platform_jobs);
            let usage_rows = lane
                .pool()
                .get()
                .await?
                .query(
                    "select content, metadata from conversation_messages
                      where run_id = $1 and metadata ->> 'messageType' = 'token_usage'",
                    &[&run],
                )
                .await?;
            assert_eq!(usage_rows.len(), 1);
            let (content, usage): (String, JsonValue) =
                (usage_rows[0].get(0), usage_rows[0].get(1));
            assert_eq!(
                content,
                "Claude Code reported: input 1000, cached 850, output 40"
            );
            assert_eq!(usage["details"]["kind"], json!("claude_code_turn_usage"));
            assert_eq!(usage["details"]["billed"], json!(false));
            assert_eq!(usage["details"]["model"], json!("claude-test-model"));
            let reply = lane
                .metadata_of(
                    "select metadata from conversation_messages
                      where run_id = $1 and role = 'assistant'
                        and metadata ->> 'outcome' = 'succeeded'",
                    run,
                )
                .await?;
            assert_lane_stamps(&reply, "reply");
            assert_eq!(reply["provider"], json!("claude-code"));
            assert!(reply.get("claudeCodeFailure").is_none(), "{reply}");

            // A failure: a code Studio words is copied, and a malformed state
            // is dropped.
            for (code, copied) in [("not_signed_in", true), ("launch_the_rockets", false)] {
                let (_, failed) = lane.lane_turn().await?;
                lane.lease_one(lane.desktop, failed).await?;
                lane.harness
                    .complete(
                        lane.desktop,
                        failed,
                        json!({
                            "outcome": "failed",
                            "error_message": "Claude Code stopped.",
                            "proxy_metadata": {
                                "provider": "claude-code",
                                "conversation": with(
                                    lane_session(lane.desktop, Uuid::new_v4()),
                                    json!({ "extra": true }),
                                ),
                            },
                            "artifacts": [{ "kind": "claude-code/failure", "code": code }],
                        }),
                    )
                    .await?;
                let (status, _, proxy_metadata) = lane.ended(failed).await?;
                assert_eq!(status, "failed");
                assert_eq!(proxy_metadata["conversation"], JsonValue::Null, "{code}");
                let run = lane.job(failed).await?.run_id.expect("run");
                let (_, metadata) = lane.failure_message(run).await?;
                assert_lane_stamps(&metadata, code);
                if copied {
                    assert_lane_failure(&metadata, code, code);
                } else {
                    assert!(metadata.get("claudeCodeFailure").is_none(), "{metadata}");
                }
            }

            // A Codex job that reports Claude Code's provider and state keeps
            // neither.
            let codex_chat = lane.chat().await?;
            let codex = lane.admitted(codex_chat, &octo_send(space.runtime)).await?;
            lane.lease_one(space.runtime, codex).await?;
            lane.harness
                .complete(
                    space.runtime,
                    codex,
                    json!({
                        "outcome": "succeeded",
                        "summary": "Read them.",
                        "proxy_metadata": {
                            "provider": "claude-code",
                            "conversation": lane_session(space.runtime, Uuid::new_v4()),
                        },
                    }),
                )
                .await?;
            let (_, _, proxy_metadata) = lane.ended(codex).await?;
            assert_eq!(proxy_metadata["provider"], JsonValue::Null);
            assert_eq!(proxy_metadata["conversation"], JsonValue::Null);
            let run = lane.job(codex).await?.run_id.expect("run");
            let run_metadata = lane
                .metadata_of("select metadata from runs where id = $1", run)
                .await?;
            assert_ne!(
                run_metadata.pointer("/provider/id"),
                Some(&json!("claude-code")),
                "{run_metadata}"
            );
            assert_eq!(
                run_metadata.pointer("/provider/conversation"),
                None,
                "{run_metadata}"
            );
            Ok(())
        },
    )
    .await
}

/// A lane session's conversation state, as the runtime saves it.
fn lane_session(runtime: Uuid, session: Uuid) -> JsonValue {
    json!({
        "provider": "claude-code",
        "version": 1,
        "sessionId": session.to_string(),
        "runtimeId": runtime.to_string(),
    })
}

/// The next lane turn resumes its own engine's session
/// (docs/Local-Engine-Turns.md 11.9): its person's, with the same agent, in
/// the same chat, whichever of their computers saved it, and the latest one.
/// A turn that saved no state, such as a stopped one, is passed over, and a
/// reset starts a new session. The Codex loader never returns lane state.
#[tokio::test]
async fn a_lane_turn_resumes_its_own_session_on_any_of_its_persons_computers() -> anyhow::Result<()>
{
    with_lane(
        "lane-resume",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let send = || lane_send(lane_metadata(json!({})));
            let state_of = |job: Uuid| {
                let lane = &lane;
                async move {
                    anyhow::Ok(
                        lane.job(job)
                            .await?
                            .payload
                            .get("provider_conversation_state")
                            .cloned(),
                    )
                }
            };
            let (first_session, latest_session) = (Uuid::new_v4(), Uuid::new_v4());
            let first = lane.admitted(chat, &send()).await?;
            assert_eq!(state_of(first).await?, None, "a first turn starts a session");
            lane.lease_one(lane.desktop, first).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    first,
                    json!({
                        "outcome": "succeeded",
                        "summary": "Done.",
                        "proxy_metadata": {
                            "conversation": lane_session(lane.desktop, first_session),
                        },
                    }),
                )
                .await?;

            // The loader keeps to the person, the agent and the chat, and not
            // to the computer that saved it.
            {
                let mut connection = lane.pool().get().await?;
                let transaction = connection.transaction().await?;
                let load = |conversation: Uuid, person: Uuid, agent: Uuid| {
                    let transaction = &transaction;
                    let project = space.project_id;
                    async move {
                        claude_code_lane::load_session(
                            transaction,
                            &project,
                            &conversation,
                            &person,
                            Some(&agent),
                        )
                        .await
                        .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.message))
                    }
                };
                assert_eq!(
                    load(chat, space.owner, lane.owner_claude).await?,
                    Some(lane_session(lane.desktop, first_session))
                );
                for (what, conversation, person, agent) in [
                    ("another chat", space.log, space.owner, lane.owner_claude),
                    ("another person", chat, space.member, lane.owner_claude),
                    ("another person's agent", chat, space.member, lane.member_claude),
                    ("another agent", chat, space.owner, space.owner_agent),
                ] {
                    assert_eq!(
                        load(conversation, person, agent).await?,
                        None,
                        "{what}"
                    );
                }
                // The Codex loader never returns it, even for a lane turn
                // that had a platform record, whose run names its agent.
                let first_run = lane.job(first).await?.run_id.expect("run");
                let run_metadata = lane
                    .metadata_of("select metadata from runs where id = $1", first_run)
                    .await?;
                assert_eq!(
                    run_metadata["agent"]["id"],
                    json!(lane.owner_claude.to_string()),
                    "{run_metadata}"
                );
                transaction
                    .execute(
                        "insert into ai_usage_jobs (job_id, org_id, project_id, run_id, billing_mode)
                         select id, $2, project_id, run_id, 'record_only'
                           from agent_jobs where id = $1",
                        &[&first, &space.org_id],
                    )
                    .await?;
                let codex_state = crate::dispatch::load_provider_conversation_state_for_job(
                    &transaction,
                    &space.project_id,
                    &chat,
                    None,
                    Some(&lane.owner_claude),
                    Some(CLAUDE),
                    None,
                )
                .await
                .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.message))?;
                assert_eq!(codex_state, None);
                transaction.rollback().await?;
            }

            // The next turn resumes it on the person's other computer, which
            // saves a session of its own.
            let second = lane.admitted(chat, &send()).await?;
            assert_eq!(
                state_of(second).await?,
                Some(lane_session(lane.desktop, first_session))
            );
            lane.lease_one(lane.second_desktop, second).await?;
            lane.harness
                .complete(
                    lane.second_desktop,
                    second,
                    json!({
                        "outcome": "succeeded",
                        "summary": "Done.",
                        "proxy_metadata": {
                            "conversation": lane_session(lane.second_desktop, latest_session),
                        },
                    }),
                )
                .await?;
            // The turn after resumes the latest, wherever it runs.
            let third = lane.admitted(chat, &send()).await?;
            assert_eq!(
                state_of(third).await?,
                Some(lane_session(lane.second_desktop, latest_session))
            );
            // Stopped, it saves nothing: the turn after it resumes the same
            // session.
            lane.lease_one(lane.desktop, third).await?;
            let (status, body) = lane
                .harness
                .call(
                    "POST",
                    format!("/jobs/{third}/cancel"),
                    Some(&lane.owner()),
                    Some(json!({})),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let fourth = lane.admitted(chat, &send()).await?;
            assert_eq!(
                state_of(fourth).await?,
                Some(lane_session(lane.second_desktop, latest_session)),
                "a stopped turn is passed over"
            );

            // A reset starts the next turn afresh.
            lane.lease_one(lane.desktop, fourth).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    fourth,
                    json!({
                        "outcome": "failed",
                        "error_message": "Claude Code stopped.",
                        "proxy_metadata": { "conversation": {
                            "provider": "claude-code", "version": 1, "reset": true,
                        } },
                    }),
                )
                .await?;
            let fifth = lane.admitted(chat, &send()).await?;
            assert_eq!(state_of(fifth).await?, None, "a reset starts a new session");
            Ok(())
        },
    )
    .await
}

/// The CHECK on `agent_jobs.engine` rejects every lane row it forbids: one
/// with a credential, grants, a parent, a plan group or a role, one with no
/// receive time, and an engine that is not `claude-code`.
#[tokio::test]
async fn the_engine_check_rejects_every_forbidden_lane_row() -> anyhow::Result<()> {
    with_lane(
        "lane-check",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let parent = lane.queued_job().await?;
            let insert = |extra_columns: &'static str, extra_values: &'static str| {
                format!(
                    "insert into agent_jobs (project_id, conversation_id, intent, status, payload,
                                         engine, trigger_received_at{extra_columns})
                 values ($1, $2, 'feature', 'completed', '{{}}'::jsonb, $3, now(){extra_values})"
                )
            };
            let credential = lane.owner_credential;
            let cases: Vec<(
                String,
                Vec<Box<dyn tokio_postgres::types::ToSql + Sync + Send>>,
            )> = vec![
                (
                    insert(", credential_id", ", $4"),
                    vec![Box::new(credential)],
                ),
                (
                    insert(", grant_ids", ", $4"),
                    vec![Box::new(vec![Uuid::new_v4()])],
                ),
                (insert(", parent_job_id", ", $4"), vec![Box::new(parent)]),
                (
                    insert(", plan_group_id", ", $4"),
                    vec![Box::new(Uuid::new_v4())],
                ),
                (
                    insert(", agent_role", ", $4"),
                    vec![Box::new("worker".to_string())],
                ),
            ];
            for (statement, extra) in &cases {
                let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
                    vec![&space.project_id, &chat, &claude_code_lane::ENGINE];
                for value in extra {
                    params.push(value.as_ref());
                }
                let error = lane
                    .pool()
                    .get()
                    .await?
                    .execute(statement.as_str(), &params)
                    .await
                    .expect_err(statement);
                assert_check_violation(&error, statement);
            }
            let no_receive_time = "insert into agent_jobs (project_id, conversation_id, intent,
                                                        status, payload, engine,
                                                        trigger_received_at)
                               values ($1, $2, 'feature', 'completed', '{}'::jsonb, $3, null)";
            let error = lane
                .pool()
                .get()
                .await?
                .execute(
                    no_receive_time,
                    &[&space.project_id, &chat, &claude_code_lane::ENGINE],
                )
                .await
                .expect_err("no receive time");
            assert_check_violation(&error, "no receive time");
            let error = lane
                .pool()
                .get()
                .await?
                .execute(
                    insert("", "").as_str(),
                    &[&space.project_id, &chat, &"codex"],
                )
                .await
                .expect_err("another engine");
            assert_check_violation(&error, "another engine");
            // The one shape it allows.
            lane.pool()
                .get()
                .await?
                .execute(
                    insert("", "").as_str(),
                    &[&space.project_id, &chat, &claude_code_lane::ENGINE],
                )
                .await?;
            Ok(())
        },
    )
    .await
}

fn assert_check_violation(error: &tokio_postgres::Error, what: &str) {
    assert_eq!(
        error.code(),
        Some(&tokio_postgres::error::SqlState::CHECK_VIOLATION),
        "{what}: {error}"
    );
    assert_eq!(
        error.as_db_error().and_then(|error| error.constraint()),
        Some("agent_jobs_engine_check"),
        "{what}: {error}"
    );
}

/// A client's copy of the controller's lane marks never persists: dispatch
/// drops it from an ordinary send, and recording a message drops it, for the
/// service role too.
#[tokio::test]
async fn a_clients_lane_stamps_never_persist() -> anyhow::Result<()> {
    with_lane(
        "lane-stamps",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let owner = lane.owner();
            let forged = json!({
                "claudeCode": { "version": 1 },
                "claude_code": { "version": 1 },
                "claudeCodeFailure": "plan_limit",
                "claudeCodeSkipped": { "reason": "computer_away" },
                "prompt_metadata": { "claudeCode": { "version": 1 } },
            });
            let lane_marks = [
                "claudeCode",
                "claude_code",
                "claudeCodeFailure",
                "claudeCodeSkipped",
            ];
            let mut send = octo_send(space.runtime);
            send["metadata"] = metadata_for(&["octo"], forged.clone());
            let job = lane.job(lane.admitted(chat, &send).await?).await?;
            assert_eq!(job.engine, None);
            assert_eq!(job.payload["metadata"]["aiAccessMode"], json!("byoc"));
            let run_id = job.run_id.expect("run");
            let message = lane
                .metadata_of(
                    "select metadata from conversation_messages
                      where run_id = $1 and role = 'user'",
                    run_id,
                )
                .await?;
            let run = lane
                .metadata_of("select metadata from runs where id = $1", run_id)
                .await?;
            for (what, value) in [
                ("payload", &job.payload),
                ("message", &message),
                ("run", &run),
            ] {
                assert_never_holds(value, &lane_marks, what);
            }

            for token in [owner.as_str(), SERVICE_ROLE] {
                let (status, recorded) = lane
                    .harness
                    .call(
                        "POST",
                        format!("/conversations/{chat}/messages/record"),
                        Some(token),
                        Some(json!({
                            "content": "A note.",
                            "metadata": with(forged.clone(), json!({
                                "details": { "claudeCodeFailure": "not_signed_in" },
                                "keep": true,
                            })),
                        })),
                    )
                    .await?;
                anyhow::ensure!(status == StatusCode::OK, "record: {status} {recorded}");
                assert_eq!(recorded["metadata"]["keep"], json!(true), "{recorded}");
                let id = Uuid::parse_str(recorded["id"].as_str().unwrap_or_default())?;
                let stored = lane
                    .metadata_of(
                        "select metadata from conversation_messages where id = $1",
                        id,
                    )
                    .await?;
                assert_never_holds(&stored, &lane_marks, token);
            }
            Ok(())
        },
    )
    .await
}

/// In a chat whose device grants name someone else
/// (`device_grants::starts_agent_turns`), a send to a Claude Code agent is
/// recorded and starts nothing, as any send there. The grant's own person's
/// Claude Code turn there holds no grant, and their ordinary turn holds it.
#[tokio::test]
async fn a_chat_granted_to_someone_else_records_a_send_to_a_claude_code_agent_and_starts_nothing(
) -> anyhow::Result<()> {
    with_lane(
        "lane-granted-chat",
        |config, space| config.device_grants = DeviceGrantUsers::Only(vec![space.member]),
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let member_octo = lane.agent_of(space.member, "octo").await?;
            sql(
                lane.pool(),
                "insert into project_provider_devices (
                     project_id, provider_id, provider_family_id, device_id, owner_user_id
                 ) values ($1, $2, $2, $3, $4)",
                &[&space.project_id, &DEVICE_PROVIDER, &DEVICE, &space.member],
            )
            .await?;
            let grant = Uuid::new_v4();
            sql(
                lane.pool(),
                "insert into agent_device_grants (
                     id, project_id, user_id, agent_id, provider_id, device_id, tool_ids,
                     conversation_id, not_before
                 ) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 hour')",
                &[
                    &grant,
                    &space.project_id,
                    &space.member,
                    &member_octo,
                    &DEVICE_PROVIDER,
                    &DEVICE,
                    &vec!["device.state.read".to_string()],
                    &chat,
                ],
            )
            .await?;

            let before = lane.written().await?;
            let (status, response) = lane
                .send(&lane.owner(), chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            assert_eq!(response["status"], json!("recorded"), "{response}");
            assert_eq!(
                lane.written().await?,
                Written {
                    messages: before.messages + 1,
                    ..before
                }
            );

            // The grant's own person: a lane turn, holding no grant.
            let member = lane.token(space.member);
            let job = lane
                .admitted_as(&member, chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            assert_lane_job(
                &lane.job(job).await?,
                space.member,
                lane.member_claude,
                "the member's turn",
            );
            // Their ordinary turn there holds it, as before.
            lane.end_jobs().await?;
            let job = lane
                .job(
                    lane.admitted_as(&member, chat, &octo_send(lane.member_desktop))
                        .await?,
                )
                .await?;
            assert_eq!(job.engine, None);
            assert_eq!(job.grant_ids, Some(vec![grant]));
            Ok(())
        },
    )
    .await
}

/// An automation whose agents all use Claude Code (docs/Local-Engine-Turns.md
/// 11.7): its run picks and launches no runtime and becomes a turn of its
/// owner's own Claude Code agent in the automation's thread, waiting for
/// their computer. A due run while that turn still waits is skipped, with no
/// error or notice and its next run set, and adds no turn. While the turn
/// runs, a due run is a turn again, which waits behind it. An automation
/// that may report nothing gives Claude Code its "nothing to report"
/// instruction in front of its words.
#[tokio::test]
async fn an_automation_of_claude_code_agents_waits_for_its_persons_computer_and_never_piles_up(
) -> anyhow::Result<()> {
    with_lane(
        "lane-automation",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let runtimes = lane.written().await?.runtimes;
            let (automation, thread) = lane.automation(json!({})).await?;
            let first_run = lane.run_automation(automation).await?;
            let jobs = lane.jobs_in(thread).await?;
            assert_eq!(jobs.len(), 1, "{jobs:?}");
            let job = lane.job(jobs[0]).await?;
            assert_lane_job(
                &job,
                space.owner,
                lane.owner_claude,
                "the automation's turn",
            );
            assert_eq!(job.payload["executionMode"], json!("shared_write"));
            assert_eq!(job.payload["prompt_text"], json!(WORDS));
            let thread_kind: Option<String> = sql_one(
                lane.pool(),
                "select thread_kind from conversations where id = $1",
                &[&thread],
            )
            .await?;
            assert_eq!(thread_kind.as_deref(), Some("automation"));
            assert_eq!(
                lane.written().await?.runtimes,
                runtimes,
                "no runtime picked or launched"
            );
            let last_error = || async {
                sql_one::<Option<String>>(
                    lane.pool(),
                    "select last_error from automations where id = $1",
                    &[&automation],
                )
                .await
            };
            assert_eq!(last_error().await?, None);

            // A due run while it waits is skipped.
            let messages = lane.written().await?.messages;
            let skipped_run = lane.run_automation(automation).await?;
            assert!(skipped_run > first_run, "{skipped_run} {first_run}");
            assert_eq!(last_error().await?, None);
            let next_run: Option<DateTime<Utc>> = sql_one(
                lane.pool(),
                "select next_run_at from automations where id = $1",
                &[&automation],
            )
            .await?;
            assert!(
                next_run.is_some_and(|next| next > Utc::now() + chrono::Duration::hours(23)),
                "{next_run:?}"
            );
            assert_eq!(lane.jobs_in(thread).await?, jobs, "no turn more");
            assert_eq!(lane.written().await?.messages, messages, "no notice");

            // While the turn runs, a due run is a turn again, which waits.
            lane.lease_one(lane.desktop, jobs[0]).await?;
            lane.run_automation(automation).await?;
            let after = lane.jobs_in(thread).await?;
            assert_eq!(after.len(), 2, "{after:?}");
            assert_lane_job(
                &lane.job(after[1]).await?,
                space.owner,
                lane.owner_claude,
                "the next run's turn",
            );

            // An automation that may report nothing.
            let (quiet, quiet_thread) = lane
                .automation(json!({ "silentWhenNothingToReport": true }))
                .await?;
            lane.run_automation(quiet).await?;
            let jobs = lane.jobs_in(quiet_thread).await?;
            assert_eq!(jobs.len(), 1, "{jobs:?}");
            let job = lane.job(jobs[0]).await?;
            assert_lane_job(&job, space.owner, lane.owner_claude, "a quiet automation");
            assert!(
                crate::group_participation::job_payload_marks_agent_evaluation(&job.payload),
                "{}",
                job.payload
            );
            let prompt = job.payload["prompt_text"].as_str().unwrap_or_default();
            assert!(
                prompt.starts_with("[Scheduled automation run")
                    && prompt.ends_with(&format!("\n\n{WORDS}")),
                "{prompt}"
            );
            Ok(())
        },
    )
    .await
}

/// An automation runs every turn in the `apply` mode, whatever mode it was
/// saved with (`automations::normalize_execution_mode`), on Claude Code as on
/// any engine (docs/Local-Engine-Turns.md 11.4): a `plan_only` automation's
/// Claude Code turn is a writing one, as its Codex turn would be.
#[tokio::test]
async fn an_automation_runs_its_claude_code_turn_in_the_mode_it_runs_any_turn() -> anyhow::Result<()>
{
    with_lane(
        "lane-automation-read-only",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (automation, thread) = lane
                .automation(json!({
                    "metadata": {
                        "agentSelection": { "active": [CLAUDE], "mentions": [CLAUDE] },
                        "execution_mode": "plan_only",
                    },
                }))
                .await?;
            lane.run_automation(automation).await?;
            let jobs = lane.jobs_in(thread).await?;
            assert_eq!(jobs.len(), 1, "{jobs:?}");
            let job = lane.job(jobs[0]).await?;
            assert_lane_job(&job, space.owner, lane.owner_claude, "a plan_only run");
            assert_eq!(
                (
                    job.payload["executionMode"].clone(),
                    job.payload["metadata"].get("execution_mode").cloned(),
                ),
                (json!("shared_write"), None),
                "{}",
                job.payload
            );
            Ok(())
        },
    )
    .await
}

/// A person's own send in the read-only `plan_only` mode is a turn Claude
/// Code can take (docs/Local-Engine-Turns.md 11.4, 11.12): its payload names
/// the mode where runtime-agent reads it, and the read-only workspace mode.
#[tokio::test]
async fn a_read_only_turn_names_its_mode_where_the_runtime_reads_it() -> anyhow::Result<()> {
    with_lane(
        "lane-read-only",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let job = lane
                .job(
                    lane.admitted(
                        chat,
                        &lane_send(lane_metadata(json!({
                            "execution_mode": "plan_only",
                            "writeIntent": false,
                        }))),
                    )
                    .await?,
                )
                .await?;
            assert_lane_job(&job, space.owner, lane.owner_claude, "a read-only turn");
            assert_eq!(job.payload["executionMode"], json!("shared_read"));
            assert_eq!(
                job.payload["metadata"]["execution_mode"],
                json!("plan_only")
            );
            assert_eq!(job.payload["writeIntent"], json!(false));
            Ok(())
        },
    )
    .await
}

/// A project of `user`'s, for the payload builders.
fn project_of(user: Uuid) -> crate::ProjectRecord {
    crate::ProjectRecord {
        id: Uuid::new_v4(),
        org_id: None,
        name: None,
        sandbox_session_id: None,
        project_type: None,
        owner_user_id: Some(user),
        _status: None,
    }
}

/// The builders of a lane job's payload and of its reply: the reply is
/// stamped as a lane turn's, and an evaluation's payload carries its
/// participation instruction in front of the message for Claude Code, the
/// same as for any engine (docs/Local-Engine-Turns.md 11.10), and keeps its
/// marker.
#[test]
fn the_payload_and_reply_builders_keep_a_lane_turn_its_own() {
    let reply = json!({ "source": "agent", "outcome": "completed" });
    let stamped = crate::agent::stamp_ai_access_mode_from_job_payload(
        reply.clone(),
        &json!({ "metadata": {
            "aiAccessMode": "claude-code",
            "managedAiUsed": false,
            "claudeCode": { "version": 1 },
        } }),
    );
    assert_eq!(stamped["source"], json!("agent"));
    assert_lane_stamps(&stamped, "reply");
    let byoc = crate::agent::stamp_ai_access_mode_from_job_payload(
        reply.clone(),
        &json!({ "metadata": { "aiAccessMode": "byoc" } }),
    );
    assert_eq!(byoc["aiAccessMode"], json!("byoc"));
    assert!(byoc.get("claudeCode").is_none());

    let user = Uuid::new_v4();
    let project = project_of(user);
    let context = person_context(user);
    let mut request = crate::dispatch::normalize_dispatch_request(
        serde_json::from_value(json!({
            "projectId": project.id.to_string(),
            "conversationId": Uuid::new_v4().to_string(),
            "promptText": WORDS,
            "metadata": { "input": { "kind": "person" }, "writeIntent": true },
        }))
        .expect("request"),
    )
    .expect("normalized");
    crate::group_participation::inject_skill_mode_agent_evaluation_metadata(&mut request.metadata);
    let (run, prompt) = (Uuid::new_v4(), Uuid::new_v4());
    let evaluation =
        crate::agent::build_agent_job_payload(&project, &context, &request, &run, &prompt, None)
            .expect("an evaluation payload");
    assert_ne!(evaluation["prompt_text"], json!(WORDS), "the instruction");
    request.claude_code_lane = Some(claude_code_lane::LaneAdmission);
    let lane_evaluation =
        crate::agent::build_agent_job_payload(&project, &context, &request, &run, &prompt, None)
            .expect("a lane evaluation payload");
    assert_eq!(
        lane_evaluation["prompt_text"], evaluation["prompt_text"],
        "the same instruction in front of the same words"
    );
    assert!(lane_evaluation["prompt_text"]
        .as_str()
        .is_some_and(|text| text.ends_with(WORDS)));
    assert!(crate::group_participation::job_payload_marks_agent_evaluation(&lane_evaluation));
    assert_lane_stamps(&lane_evaluation["metadata"], "a lane evaluation");
}

/// A lane job's payload names its workspace mode by its execution mode, which
/// runtime-agent reads, whatever workspace mode the client's metadata asked
/// for under any of the keys dispatch reads it by: a write in the space's
/// folder, or `shared_read` for the read-only `plan_only`, which its metadata
/// then names too (docs/Local-Engine-Turns.md 11.12). Any other job keeps the
/// mode dispatch resolved from it.
#[test]
fn a_lane_payload_names_its_workspace_mode_by_its_execution_mode_alone() {
    let user = Uuid::new_v4();
    let project = project_of(user);
    let context = person_context(user);
    let (run, prompt) = (Uuid::new_v4(), Uuid::new_v4());
    for (key, mode) in [
        ("workspaceMode", "shared_read"),
        ("workspaceMode", "isolated_write"),
        ("executionMode", "isolated_write"),
        ("workspace_mode", "shared_read"),
        ("workspaceMode", "shared_write"),
    ] {
        let mut metadata = json!({ "input": { "kind": "person" }, "writeIntent": true });
        metadata[key] = json!(mode);
        let mut request = crate::dispatch::normalize_dispatch_request(
            serde_json::from_value(json!({
                "projectId": project.id.to_string(),
                "conversationId": Uuid::new_v4().to_string(),
                "promptText": WORDS,
                "metadata": metadata,
            }))
            .expect("request"),
        )
        .expect("normalized");
        assert_eq!(request.workspace_mode, mode, "{key}");
        let codex = crate::agent::build_agent_job_payload(
            &project, &context, &request, &run, &prompt, None,
        )
        .expect("a payload");
        assert_eq!(codex["executionMode"], json!(mode), "{key}");
        request.claude_code_lane = Some(claude_code_lane::LaneAdmission);
        let lane = crate::agent::build_agent_job_payload(
            &project, &context, &request, &run, &prompt, None,
        )
        .expect("a lane payload");
        assert_eq!(
            lane["executionMode"],
            json!("shared_write"),
            "{key}: {mode}"
        );
        assert!(lane["metadata"].get("execution_mode").is_none(), "{lane}");
        assert_never_holds(&lane["metadata"], &["workspaceMode", "executionMode"], key);
        request.execution_mode = "plan_only".to_string();
        let read_only = crate::agent::build_agent_job_payload(
            &project, &context, &request, &run, &prompt, None,
        )
        .expect("a read-only lane payload");
        assert_eq!(
            read_only["executionMode"],
            json!("shared_read"),
            "{key}: {mode}"
        );
        assert_eq!(read_only["metadata"]["execution_mode"], json!("plan_only"));
    }
}

/// L1 and L2 of `check_target` (docs/Local-Engine-Turns.md 11.6): a target
/// with no person behind the dispatch, or with no saved agent, is no turn of
/// its owner's; a person the switch leaves out is refused; and a turn that
/// needs Instafy's browser, as a strict browser target does, is refused with
/// L3's reason. The owner's own plain turn passes.
#[test]
fn a_target_passes_only_as_its_owners_own_turn_on_the_switch() {
    let (owner, outsider) = (Uuid::new_v4(), Uuid::new_v4());
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "lane-check-target",
    );
    config.claude_code_lane = ClaudeCodeLaneUsers(DeviceGrantUsers::Only(vec![owner]));
    let request = crate::dispatch::normalize_dispatch_request(
        serde_json::from_value(json!({
            "projectId": Uuid::new_v4().to_string(),
            "promptText": WORDS,
            "metadata": lane_metadata(json!({})),
        }))
        .expect("request"),
    )
    .expect("normalized");
    let agent = Some(Uuid::new_v4());
    let check = |user: Option<Uuid>, agent_id: Option<Uuid>, uses_browser: bool| {
        claude_code_lane::check_target(
            &config,
            &RequestContext {
                user_id: user,
                is_service_role: user.is_none(),
                scoped_claims: None,
            },
            &request,
            claude_code_lane::Target {
                agent_id,
                uses_browser,
                prompt_text: &request.prompt_text,
            },
        )
        .err()
        .map(|(status, Json(error))| {
            (
                status,
                error.code.clone().unwrap_or_default(),
                reason_of(&error).unwrap_or_default().to_string(),
            )
        })
    };
    let refused =
        |expected: Expected| Some((expected.0, expected.1.to_string(), expected.2.to_string()));
    assert_eq!(check(Some(owner), agent, false), None);
    assert_eq!(check(None, agent, false), refused(unsupported("no_owner")));
    assert_eq!(
        check(Some(owner), None, false),
        refused(unsupported("no_owner"))
    );
    assert_eq!(check(Some(outsider), agent, false), refused(not_allowed()));
    assert_eq!(
        check(Some(owner), agent, true),
        refused(unsupported("browser"))
    );
}
