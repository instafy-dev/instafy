#![cfg(test)]

// Local-engine turns on the migrated database (docs/Local-Engine-Turns.md
// 2.1-2.3, 2.5, 2.9 and section 8): dispatch admits a claimed send as one turn
// its person's own Claude Code runs on their own computer, and refuses every
// other claimed send before it writes a prompt, run, message or job or burns a
// credit. The space and harness are `tests_provider_space.rs`'s, seeded here
// with lane-ready computers. Requires `TEST_DATABASE_URL` like the tests in
// `tests.rs`.

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
const DEVICE_PROVIDER: &str = "device:lane-test";
const DEVICE: &str = "lane-device-1";

type Expected = (StatusCode, &'static str, &'static str);

fn not_allowed(reason: &'static str) -> Expected {
    (
        StatusCode::FORBIDDEN,
        claude_code_lane::TURN_NOT_ALLOWED,
        reason,
    )
}

fn not_person(reason: &'static str) -> Expected {
    (
        StatusCode::FORBIDDEN,
        claude_code_lane::TURN_NOT_PERSON,
        reason,
    )
}

fn not_plain(reason: &'static str) -> Expected {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        claude_code_lane::TURN_NOT_PLAIN,
        reason,
    )
}

fn not_ready(reason: &'static str) -> Expected {
    (
        StatusCode::CONFLICT,
        claude_code_lane::RUNTIME_NOT_READY,
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

/// A claimed send's metadata as Studio sends it, with `extra` over it.
fn lane_metadata(extra: JsonValue) -> JsonValue {
    with(
        json!({
            "clientMessageId": Uuid::new_v4().to_string(),
            "turnEngine": "claude-code",
            "agentSelection": { "active": ["octo"], "mentions": ["octo"] },
            "input": { "kind": "person" },
            "writeIntent": true,
        }),
        extra,
    )
}

/// A claimed send of [`WORDS`] to `runtime`, with `metadata`.
fn lane_send(runtime: Uuid, metadata: JsonValue) -> JsonValue {
    json!({
        "promptText": WORDS,
        "intent": "feature",
        "runtimeId": runtime.to_string(),
        "metadata": metadata,
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

type Adjustment = Box<dyn FnOnce(&mut DispatchPromptNormalized)>;

/// What an internal caller sets on a request beyond what the routes set.
fn adjustment(adjust: impl FnOnce(&mut DispatchPromptNormalized) + 'static) -> Adjustment {
    Box::new(adjust)
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
/// (`tests_provider_space.rs`'s `Space`), each with a default AI connection,
/// and the computers lane turns run on.
struct Lane {
    harness: Harness,
    /// The owner's own lane-ready computers.
    desktop: Uuid,
    second_desktop: Uuid,
    /// The member's own lane-ready computer.
    member_desktop: Uuid,
    /// The owner's default AI connection.
    owner_credential: Uuid,
    other_project_runtime: Uuid,
    service_user: Uuid,
}

/// Runs `body` on a fresh lane space whose config `configure` may change,
/// then deletes it.
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
    let other_project = Uuid::new_v4();
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
        projects: vec![space.project_id, other_project],
    };
    let state = build_test_state(pool.clone(), config);
    let app = Router::new()
        .merge(crate::dispatch::router())
        .merge(crate::conversations::router())
        .merge(crate::send_queue::router())
        .merge(crate::send_intents::router())
        .merge(crate::agent::router())
        .merge(crate::automations::router())
        .merge(crate::device_grants::router())
        .merge(crate::secrets::router())
        .with_state(state.clone());
    let body_pool = pool.clone();
    let label = label.to_string();
    let result = with_shared_db_fixture(fixture, async move {
        let lane = Lane::seed(
            body_pool,
            state,
            app,
            space,
            other_project,
            service_user,
            &label,
        )
        .await?;
        body(lane).await
    })
    .await;
    let cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = any($1)", &[&users])
        .await;
    result.and(cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

impl Lane {
    async fn seed(
        pool: PgPool,
        state: AppState,
        app: Router,
        space: Space,
        other_project: Uuid,
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
        for project in [space.project_id, other_project] {
            connection
                .execute(
                    "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                     values ($1, $2, $3, $4, 'customer', 'active')",
                    &[&project, &space.org_id, &label, &space.owner],
                )
                .await?;
        }
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
        for (project, owner) in [
            (space.project_id, space.owner),
            (space.project_id, space.owner),
            (space.project_id, space.member),
            (other_project, space.owner),
        ] {
            let id = Uuid::new_v4();
            insert_runtime(
                &pool,
                id,
                project,
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
            owner_credential: owner_credential.expect("owner credential"),
            other_project_runtime: lane_runtimes[3],
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
                        (select count(*) from conversation_send_queue where project_id = $1)",
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
        })
    }

    /// `token`'s holder posts `body` to `path`: refused as `expected`, with
    /// nothing written.
    async fn refused_at(
        &self,
        token: &str,
        path: String,
        body: JsonValue,
        expected: Expected,
    ) -> anyhow::Result<JsonValue> {
        let before = self.written().await?;
        let (status, response) = self
            .harness
            .call("POST", path.clone(), Some(token), Some(body.clone()))
            .await?;
        assert_eq!(
            (
                status,
                response["code"].as_str(),
                response["details"]["reason"].as_str()
            ),
            (expected.0, Some(expected.1), Some(expected.2)),
            "{path} {body}: {response}"
        );
        assert_eq!(
            self.written().await?,
            before,
            "{path} {body} wrote something"
        );
        Ok(response)
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
        self.refused_at(
            token,
            format!("/conversations/{conversation}/messages"),
            body,
            expected,
        )
        .await
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
    /// `context`, `adjust`ed: refused as `expected`, with nothing written.
    async fn refused_directly(
        &self,
        context: RequestContext,
        conversation: Uuid,
        body: JsonValue,
        adjust: impl FnOnce(&mut DispatchPromptNormalized),
        expected: Expected,
    ) -> anyhow::Result<()> {
        let request = self.request(&context, conversation, body, adjust)?;
        let before = self.written().await?;
        let (status, Json(error)) =
            crate::dispatch::process_dispatch_prompt(&self.harness.state, &context, request)
                .await
                .err()
                .ok_or_else(|| anyhow::anyhow!("dispatched {expected:?}"))?;
        assert_eq!(
            (status, error.code.as_deref(), reason_of(&error)),
            (expected.0, Some(expected.1), Some(expected.2)),
            "{}",
            error.message
        );
        assert_eq!(
            self.written().await?,
            before,
            "{expected:?} wrote something"
        );
        Ok(())
    }

    /// The owner's claimed `body` to `conversation`: admitted, and its job.
    async fn admitted(&self, conversation: Uuid, body: &JsonValue) -> anyhow::Result<Uuid> {
        let (status, response) = self.send(&self.owner(), conversation, body).await?;
        anyhow::ensure!(status == StatusCode::OK, "send: {status} {response}");
        Ok(
            Uuid::parse_str(response["jobId"].as_str().unwrap_or_default())
                .map_err(|_| anyhow::anyhow!("send queued no job: {response}"))?,
        )
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

    /// A job that keeps `runtime` busy: queued for it, or leased by it.
    async fn busy_job(&self, runtime: Uuid, leased: bool) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        let conversation = self.chat().await?;
        sql(
            self.pool(),
            "insert into agent_jobs (
                 id, project_id, conversation_id, intent, status, payload,
                 target_runtime_id, leased_by_runtime_id, leased_at, lease_expires_at
             ) values (
                 $1, $2, $3, 'feature', $4,
                 '{\"metadata\":{\"agent\":{\"handle\":\"helper\"}}}'::jsonb,
                 case when $5 then null else $6::uuid end,
                 case when $5 then $6::uuid else null end,
                 case when $5 then now() else null end,
                 case when $5 then now() + interval '2 minutes' else null end
             )",
            &[
                &id,
                &self.space().project_id,
                &conversation,
                &if leased { "leased" } else { "queued" },
                &leased,
                &runtime,
            ],
        )
        .await?;
        Ok(id)
    }

    async fn metadata_of(&self, query: &str, id: Uuid) -> anyhow::Result<JsonValue> {
        Ok(sql_one::<Option<JsonValue>>(self.pool(), query, &[&id])
            .await?
            .unwrap_or(JsonValue::Null))
    }

    /// A claimed send of the owner's to `runtime` in a new chat, admitted:
    /// the chat and the job.
    async fn lane_turn(&self, runtime: Uuid) -> anyhow::Result<(Uuid, Uuid)> {
        let chat = self.chat().await?;
        let job = self
            .admitted(chat, &lane_send(runtime, lane_metadata(json!({}))))
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

    async fn pin(&self, job: Uuid, runtime: Uuid) -> anyhow::Result<()> {
        sql(
            self.pool(),
            "update agent_jobs set target_runtime_id = $2 where id = $1",
            &[&job, &runtime],
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

    /// Stops `runtime` as a runtime stop does, then brings it back: the jobs
    /// the stop put back in the queue, and the lane turns it failed, each
    /// with whether it recorded a failure message.
    async fn stop_runtime(&self, runtime: Uuid) -> anyhow::Result<(Vec<Uuid>, Vec<(Uuid, bool)>)> {
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
        connection
            .execute(
                "update runtimes set status = 'ready', last_seen_at = now() where id = $1",
                &[&runtime],
            )
            .await?;
        let failed = outcome
            .failed_claude_code_turns
            .iter()
            .map(|turn| (turn.job_id, turn.message.is_some()))
            .collect();
        Ok((outcome.requeued_jobs, failed))
    }
}

/// A failure message of a lane turn the controller ended as `code`: Studio
/// words it by these two keys alone (docs/Local-Engine-Turns.md 5.5).
fn assert_lane_failure(metadata: &JsonValue, code: &str, what: &str) {
    assert_eq!(
        metadata["aiAccessMode"],
        json!("claude-code"),
        "{what}: {metadata}"
    );
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

/// One admitted turn: the job runs on its sender's own computer, with the
/// controller's stamps, no credential though the sender has a default one, no
/// conversation runtime preference and no platform record. Its payload
/// carries the recorded words alone and only the metadata the lane allows.
#[tokio::test]
async fn a_claimed_send_is_one_turn_on_its_persons_own_computer() -> anyhow::Result<()> {
    with_lane(
        "lane-admitted",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
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
            });
            let body = lane_send(lane.desktop, lane_metadata(client_extras.clone()));
            let job_id = lane.admitted(chat, &body).await?;

            let job = lane.job(job_id).await?;
            assert_eq!(job.engine.as_deref(), Some(claude_code_lane::ENGINE));
            assert_eq!(
                job.credential_id, None,
                "a BYOC sender's connection is cleared"
            );
            assert_eq!(job.grant_ids, None);
            assert_eq!(job.target_runtime_id, Some(lane.desktop));
            assert!(job.trigger_received_at.is_some());
            assert_eq!(
                (
                    job.parent_job_id,
                    job.plan_group_id,
                    job.agent_role.as_deref()
                ),
                (None, None, None)
            );
            assert_eq!((job.status.as_str(), job.lease_attempts), ("queued", 0));

            let payload = &job.payload;
            assert_eq!(payload["user_id"], json!(space.owner.to_string()));
            assert_eq!(
                payload["prompt_text"],
                json!(WORDS),
                "no preamble or segment"
            );
            for key in ["bootstrap", "plan_seed", "tool_limits", "repo"] {
                assert!(payload.get(key).is_none(), "{key}: {payload}");
            }
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
                    "runtimePreference",
                    "writeIntent",
                    "writeScope",
                ],
                "{payload}"
            );
            assert_lane_stamps(&payload["metadata"], "payload");
            assert_eq!(metadata["agent"]["handle"], json!("octo"));
            assert_eq!(metadata["writeScope"]["mode"], json!("unscoped"));
            assert_eq!(metadata["input"], json!({ "kind": "person" }));
            assert_eq!(metadata["writeIntent"], json!(true));
            assert_eq!(
                metadata["runtimePreference"]["runtimeId"],
                json!(lane.desktop.to_string())
            );

            let run_id = job.run_id.expect("run");
            let run = lane
                .metadata_of("select metadata from runs where id = $1", run_id)
                .await?;
            assert_lane_stamps(&run, "run");
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
                "select metadata from conversation_messages where run_id = $1 and role = 'user'",
                run_id,
            )
            .await?;
            assert_lane_stamps(&message, "message");
            assert_eq!(message["trigger"], json!("person"));
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
                    &["turnEngine", "claudeCodeFailure", "workerInputRouting"],
                    what,
                );
            }
            // The computer never becomes the chat's runtime preference.
            let conversation = lane
                .metadata_of("select metadata from conversations where id = $1", chat)
                .await?;
            assert!(
                conversation.get("runtimePreference").is_none(),
                "{conversation}"
            );
            let after = lane.written().await?;
            assert_eq!(
                after.platform_jobs, before.platform_jobs,
                "no ai_usage_jobs row"
            );
            assert_eq!(after.ledger, before.ledger, "no credit burned");
            assert_eq!(
                (after.prompts, after.runs, after.messages, after.jobs),
                (
                    before.prompts + 1,
                    before.runs + 1,
                    before.messages + 1,
                    before.jobs + 1
                )
            );

            // The same send without the claim is an ordinary turn of the
            // sender's own connection, words and client metadata included.
            let codex_chat = lane.chat().await?;
            let mut unclaimed = body.clone();
            unclaimed["metadata"] = without(lane_metadata(client_extras), &["turnEngine"]);
            let codex = lane
                .job(lane.admitted(codex_chat, &unclaimed).await?)
                .await?;
            assert_eq!(codex.engine, None);
            assert_eq!(codex.credential_id, Some(lane.owner_credential));
            assert_eq!(
                codex.payload["prompt_text"],
                json!("Delete the repository.")
            );
            assert_eq!(codex.payload["metadata"]["userId"], json!(someone_else));
            assert_eq!(codex.payload["metadata"]["aiAccessMode"], json!("byoc"));
            assert!(codex.payload.get("bootstrap").is_some());
            assert_never_holds(
                &codex.payload,
                &["claudeCode", "claudeCodeFailure"],
                "codex",
            );
            Ok(())
        },
    )
    .await
}

/// Stage 1 (G1-G3): only the person's own session's message, sent now, with
/// no mark of anything Instafy wrote, queued, resent or delegated. Each
/// refusal writes nothing.
#[tokio::test]
async fn stage_one_refuses_what_its_person_did_not_send_now() -> anyhow::Result<()> {
    with_lane(
        "lane-stage-one",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let owner = lane.owner();
            let send = |metadata: JsonValue| lane_send(lane.desktop, metadata);
            let plain = || send(lane_metadata(json!({})));

            // G1: a sender the list leaves out, and the service role's route,
            // which names no person.
            lane.refused(
                &lane.token(space.guest),
                chat,
                plain(),
                not_allowed("not_allowed"),
            )
            .await?;
            lane.refused(SERVICE_ROLE, chat, plain(), not_allowed("not_allowed"))
                .await?;

            // G2: the service role acting as the person, inside dispatch.
            let service = RequestContext {
                user_id: Some(space.owner),
                is_service_role: true,
                scoped_claims: None,
            };
            lane.refused_directly(service, chat, plain(), |_| {}, not_person("service_role"))
                .await?;
            // A job's own token, which acts as its person there.
            let codex_chat = lane.chat().await?;
            let codex_send = json!({
                "promptText": "Read the logs.",
                "intent": "feature",
                "runtimeId": space.runtime.to_string(),
                "metadata": without(lane_metadata(json!({})), &["turnEngine"]),
            });
            lane.admitted(codex_chat, &codex_send).await?;
            let leased = lane.harness.lease(space.runtime).await?;
            let job_token = leased["controller_token"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("no job token: {leased}"))?
                .to_string();
            lane.refused(
                &job_token,
                codex_chat,
                plain(),
                not_person("not_own_session"),
            )
            .await?;
            // The internal callers that send in the person's name: an automation,
            // a goal wake-up and a team's plan, which have no trigger.
            let person = person_context(space.owner);
            lane.refused_directly(
                person.clone(),
                chat,
                plain(),
                |request| {
                    request.trigger = None;
                    request.allow_silent_automation_decline = true;
                },
                not_person("not_own_session"),
            )
            .await?;
            lane.refused_directly(
                person.clone(),
                chat,
                plain(),
                |request| {
                    request.trigger = None;
                    request.goal_wakeup = Some((Uuid::new_v4(), Uuid::new_v4()));
                },
                not_person("not_own_session"),
            )
            .await?;
            lane.refused_directly(
                person.clone(),
                chat,
                plain(),
                |request| request.delegating_job_id = Some(Uuid::new_v4()),
                not_person("delegated"),
            )
            .await?;
            // Each of their marks refuses on its own, even with the person's own
            // trigger.
            for (reason, adjust) in [
                (
                    "queued",
                    adjustment(|request| request.dispatch_queue_entry_id = Some(Uuid::new_v4())),
                ),
                (
                    "goal_wakeup",
                    adjustment(|request| {
                        request.goal_wakeup = Some((Uuid::new_v4(), Uuid::new_v4()))
                    }),
                ),
                (
                    "goal_parent_job",
                    adjustment(|request| request.goal_parent_job_id = Some(Uuid::new_v4())),
                ),
                (
                    "automation",
                    adjustment(|request| request.allow_silent_automation_decline = true),
                ),
                (
                    "internal_review",
                    adjustment(|request| request.allow_internal_review = true),
                ),
                (
                    "received_earlier",
                    adjustment(|request| {
                        request.trigger = request.trigger.take().map(|trigger| {
                            trigger.received_at(Utc::now() - chrono::Duration::seconds(5))
                        })
                    }),
                ),
            ] {
                lane.refused_directly(person.clone(), chat, plain(), adjust, not_person(reason))
                    .await?;
            }

            // A send with no input, or a device's.
            lane.refused(
                &owner,
                chat,
                send(without(lane_metadata(json!({})), &["input"])),
                not_person("not_typed"),
            )
            .await?;
            lane.refused(
                &owner,
                chat,
                send(lane_metadata(json!({
                    "input": { "kind": "device", "deviceId": "speaker-1" }
                }))),
                not_person("not_typed"),
            )
            .await?;

            // G3: the claims dispatch takes, and every mark of Instafy's.
            for (extra, reason) in [
                (
                    json!({ "siteIntent": { "previewId": Uuid::new_v4().to_string() } }),
                    "site_intent",
                ),
                (
                    json!({ "continuesFromBrowserJob": Uuid::new_v4().to_string() }),
                    "hand_back",
                ),
                (
                    json!({
                        "retryAutomatic": true,
                        "retryOfMessageId": Uuid::new_v4().to_string(),
                    }),
                    "automatic_retry",
                ),
                (
                    json!({ "retryOfMessageId": Uuid::new_v4().to_string() }),
                    "resend",
                ),
                (json!({ "retryAutomatic": false }), "resend"),
                (
                    json!({ "goalContinuation": { "turn": 2 } }),
                    "goal_continuation",
                ),
                (
                    json!({ "goal_continuation": { "source": "manual_resume" } }),
                    "goal_continuation",
                ),
                (
                    json!({ "dispatchContent": "Continue this browser task." }),
                    "dispatch_content",
                ),
                (json!({ "dispatch_content": null }), "dispatch_content"),
                (
                    json!({ "displayContent": "Octo opened a browser" }),
                    "display_content",
                ),
                (json!({ "display_content": "x" }), "display_content"),
                (json!({ "composerMessage": "x" }), "display_content"),
                (json!({ "composer_message": "x" }), "display_content"),
                (json!({ "browserTransport": "shared" }), "special_dispatch"),
                (
                    json!({ "browser_transport": "desktop-personal" }),
                    "special_dispatch",
                ),
                (json!({ "agentThread": { "id": "t" } }), "special_dispatch"),
                (json!({ "agent_thread": true }), "special_dispatch"),
                (json!({ "automation": { "id": "a" } }), "special_dispatch"),
                (json!({ "command": { "type": "goal" } }), "special_dispatch"),
                (json!({ "linkedThreadId": "t" }), "special_dispatch"),
                (json!({ "linked_thread_id": "t" }), "special_dispatch"),
                (
                    json!({ "controllerDispatch": { "suppressUserMessage": false } }),
                    "controller_dispatch",
                ),
                (
                    json!({ "controller_dispatch": true }),
                    "controller_dispatch",
                ),
                (
                    json!({ "spaceReview": { "enforcedBy": "runtime-controller" } }),
                    "space_review",
                ),
                (json!({ "space_review": {} }), "space_review"),
                (
                    json!({ "browserRequestOf": format!("job:{}", Uuid::new_v4()) }),
                    "browser_card",
                ),
            ] {
                lane.refused(&owner, chat, send(lane_metadata(extra)), not_person(reason))
                    .await?;
            }
            // A thread kind on the request.
            lane.refused(
                &owner,
                chat,
                with(plain(), json!({ "threadKind": "agent" })),
                not_person("thread_kind"),
            )
            .await?;

            // The queue's own sends of a claimed entry, which only an older
            // controller could have stored: Send now, and a drain.
            let queued = lane.written().await?;
            for _ in 0..2 {
                sql(
                    lane.pool(),
                    "insert into conversation_send_queue (
                     project_id, conversation_id, user_id, status, target_agent_handles, request
                 ) values ($1, $2, $3, 'queued', array['octo'], $4)",
                    &[&space.project_id, &chat, &space.owner, &PgJson(plain())],
                )
                .await?;
            }
            let entries: Vec<Uuid> = lane
                .pool()
                .get()
                .await?
                .query(
                    "select id from conversation_send_queue where conversation_id = $1
                  order by queue_position",
                    &[&chat],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect();
            let with_entries = lane.written().await?;
            assert_eq!(with_entries.queued, queued.queued + 2);
            lane.refused_at(
                &owner,
                format!("/conversations/{chat}/send-queue/{}/dispatch", entries[0]),
                json!({}),
                not_person("queued"),
            )
            .await?;
            crate::send_queue::spawn_send_queue_drain(lane.harness.state.clone(), chat);
            eventually("the drain to refuse the claimed entry", || async {
                let status: String = sql_one(
                    lane.pool(),
                    "select status from conversation_send_queue where id = $1",
                    &[&entries[1]],
                )
                .await?;
                Ok((status == "failed").then_some(()))
            })
            .await?;
            assert_eq!(lane.written().await?, with_entries);
            let errors: Vec<String> = lane
                .pool()
                .get()
                .await?
                .query(
                    "select coalesce(error_message, '') from conversation_send_queue
                  where conversation_id = $1 order by queue_position",
                    &[&chat],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect();
            assert_eq!(errors.len(), 2);
            Ok(())
        },
    )
    .await
}

/// Stage 2, G4 and G5: one plain turn to the sender's own @octo, of a plain
/// shape. Each refusal writes nothing.
#[tokio::test]
async fn stage_two_refuses_anything_but_one_plain_turn_to_octo() -> anyhow::Result<()> {
    with_lane("lane-plain", |_, _| {}, |lane| async move {
        let space = lane.space();
        let chat = lane.chat().await?;
        let owner = lane.owner();
        let send = |metadata: JsonValue| lane_send(lane.desktop, metadata);
        let plain = || send(lane_metadata(json!({})));

        // G4.
        for (extra, reason) in [
            (
                json!({ "agentSelection": { "active": ["octo", "helper"], "mentions": ["octo", "helper"] } }),
                "targets",
            ),
            (
                json!({ "agentSelection": { "active": ["helper"], "mentions": ["helper"] } }),
                "not_octo",
            ),
            (
                json!({ "runtimeRouting": { "strategy": "spread" } }),
                "not_plain_turn",
            ),
        ] {
            lane.refused(&owner, chat, send(lane_metadata(extra)), not_plain(reason))
                .await?;
        }
        lane.refused(
            &owner,
            chat,
            with(plain(), json!({ "planSeed": { "steps": ["one"] } })),
            not_plain("not_plain_turn"),
        )
        .await?;
        // A message recorded earlier under the same client message id.
        let client_message_id = Uuid::new_v4().to_string();
        let (status, recorded) = lane
            .harness
            .call(
                "POST",
                format!("/conversations/{chat}/messages/record"),
                Some(&owner),
                Some(json!({
                    "content": WORDS,
                    "clientMessageId": client_message_id,
                    "metadata": { "input": { "kind": "person" } },
                })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "record: {status} {recorded}");
        lane.refused(
            &owner,
            chat,
            send(lane_metadata(json!({ "clientMessageId": client_message_id }))),
            not_plain("recorded_earlier"),
        )
        .await?;

        // G5.
        lane.refused(
            &owner,
            chat,
            with(plain(), json!({ "intent": "terminal_command" })),
            not_plain("intent"),
        )
        .await?;
        for mode in ["plan_only", "approval_required"] {
            lane.refused(
                &owner,
                chat,
                send(lane_metadata(json!({ "execution_mode": mode }))),
                not_plain("execution_mode"),
            )
            .await?;
        }
        for (extra, reason) in [
            (json!({ "toolLimits": { "maxSteps": 3 } }), "tool_limits"),
            (json!({ "repo": { "owner": "o", "name": "n" } }), "repo"),
            (json!({ "ui": { "requestedPreview": true } }), "requested_preview"),
            (json!({ "ui": { "requestedPreview": false } }), "requested_preview"),
            (json!({ "promptText": "/review the diff" }), "command"),
            (json!({ "promptText": "  \n /compact" }), "command"),
            (
                json!({ "promptText": "a".repeat(crate::config::CLAUDE_CODE_LANE_MAX_PROMPT_CHARS + 1) }),
                "too_long",
            ),
        ] {
            lane.refused(&owner, chat, with(plain(), extra), not_plain(reason))
                .await?;
        }
        // A conversation that is a thread.
        let thread = Uuid::new_v4();
        sql(
            lane.pool(),
            "insert into conversations (
                 id, project_id, created_by, metadata, visibility, parent_conversation_id,
                 root_conversation_id, thread_kind
             ) values ($1, $2, $3, '{}'::jsonb, 'public', $4, $4, 'agent')",
            &[&thread, &space.project_id, &space.owner, &chat],
        )
        .await?;
        lane.refused(&owner, thread, plain(), not_plain("thread_kind"))
            .await?;
        for (extra, reason) in [
            (
                json!({ "attachments": [{ "kind": "image", "storagePath": "chat/a.png" }] }),
                "attachments",
            ),
            (json!({ "writeIntent": false }), "write_intent"),
            (
                json!({ "writeScope": { "mode": "read_only", "ownedPaths": [] } }),
                "write_scope",
            ),
            (json!({ "write_scope": null }), "write_scope"),
            (json!({ "writeScopes": { "octo": ["src/"] } }), "write_scope"),
            (json!({ "write_scopes": null }), "write_scope"),
            (json!({ "agentWriteScopes": {} }), "write_scope"),
            (json!({ "agent_write_scopes": null }), "write_scope"),
            (
                json!({ "agentSelection": {
                    "active": ["octo"], "mentions": ["octo"], "writeScopes": null
                } }),
                "write_scope",
            ),
            (
                json!({ "agentSelection": {
                    "active": ["octo"], "mentions": ["octo"], "write_scopes": { "octo": [] }
                } }),
                "write_scope",
            ),
        ] {
            lane.refused(&owner, chat, send(lane_metadata(extra)), not_plain(reason))
                .await?;
        }
        // The longest message is a turn.
        let longest = with(
            plain(),
            json!({ "promptText": "é".repeat(crate::config::CLAUDE_CODE_LANE_MAX_PROMPT_CHARS) }),
        );
        lane.admitted(chat, &longest).await?;
        Ok(())
    })
    .await
}

/// Stage 2, G6 and G7: only the runtime the send names, when it is the
/// sender's own private computer in this space, ready, without a Personal
/// Browser, with the attested capability, and idle. Each refusal writes
/// nothing.
#[tokio::test]
async fn stage_two_refuses_any_computer_but_the_senders_own_ready_idle_one() -> anyhow::Result<()> {
    with_lane(
        "lane-computer",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let owner = lane.owner();
            let on = |runtime: Uuid| lane_send(runtime, lane_metadata(json!({})));

            // No runtime named, though the chat prefers the owner's computer.
            sql(
                lane.pool(),
                "update conversations set metadata = $2 where id = $1",
                &[
                    &chat,
                    &PgJson(json!({ "runtimePreference": {
                    "runtimeId": lane.desktop.to_string(),
                    "source": "conversation",
                    "updatedAt": Utc::now().to_rfc3339(),
                } })),
                ],
            )
            .await?;
            lane.refused(
                &owner,
                chat,
                without(on(lane.desktop), &["runtimeId"]),
                not_ready("no_runtime"),
            )
            .await?;
            // A runtime in another space, and one that does not exist.
            lane.refused(
                &owner,
                chat,
                on(lane.other_project_runtime),
                not_ready("runtime_missing"),
            )
            .await?;
            lane.refused(
                &owner,
                chat,
                on(Uuid::new_v4()),
                not_ready("runtime_missing"),
            )
            .await?;
            // A teammate's computer.
            lane.refused(
                &owner,
                chat,
                on(lane.member_desktop),
                not_ready("not_owner"),
            )
            .await?;
            // A hosted runtime that reports the capability.
            let hosted = lane
                .computer(
                    "instafy-cloud",
                    capabilities(None, lane_ready()),
                    "ready",
                    600,
                )
                .await?;
            lane.refused(&owner, chat, on(hosted), not_ready("not_private"))
                .await?;
            // A service-owned one.
            let service_owned = lane
                .computer(
                    "self-hosted",
                    capabilities(Some(lane.service_user), lane_ready()),
                    "ready",
                    600,
                )
                .await?;
            lane.refused(&owner, chat, on(service_owned), not_ready("not_owner"))
                .await?;
            // A Personal Browser computer of the owner's.
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
            lane.refused(
                &owner,
                chat,
                on(personal_browser),
                not_ready("personal_browser"),
            )
            .await?;
            // Not dispatch-ready: silent, stopped, or without an agent.
            for (status, seen, extra) in [
                ("ready", -600, json!({})),
                ("stopped", 600, json!({})),
                ("ready", 600, json!({ "agent": false })),
            ] {
                let computer = lane
                    .computer(
                        "self-hosted",
                        capabilities(Some(space.owner), with(lane_ready(), extra)),
                        status,
                        seen,
                    )
                    .await?;
                lane.refused(&owner, chat, on(computer), not_ready("not_dispatch_ready"))
                    .await?;
            }
            // A missing or unattested capability, or one that is not ready.
            for (capability, reason) in [
                (json!({}), "capability_missing"),
                (
                    json!({ "claudeCode": { "ready": true } }),
                    "capability_missing",
                ),
                (
                    json!({ "claudeCode": { "version": 2, "ready": true } }),
                    "capability_missing",
                ),
                (
                    json!({ "claudeCode": { "version": "1", "ready": true } }),
                    "capability_missing",
                ),
                (
                    json!({ "claudeCode": { "version": 1, "ready": false } }),
                    "capability_not_ready",
                ),
                (
                    json!({ "claudeCode": { "version": 1, "ready": "true" } }),
                    "capability_not_ready",
                ),
            ] {
                let computer = lane
                    .computer(
                        "self-hosted",
                        capabilities(Some(space.owner), capability),
                        "ready",
                        600,
                    )
                    .await?;
                lane.refused(&owner, chat, on(computer), not_ready(reason))
                    .await?;
            }

            // G7: a job queued for the computer, or leased by it.
            for leased in [false, true] {
                let busy = lane.busy_job(lane.desktop, leased).await?;
                lane.refused(
                    &owner,
                    chat,
                    on(lane.desktop),
                    (
                        StatusCode::CONFLICT,
                        claude_code_lane::MACHINE_BUSY,
                        "machine_busy",
                    ),
                )
                .await?;
                sql(
                    lane.pool(),
                    "delete from agent_jobs where id = $1",
                    &[&busy],
                )
                .await?;
            }
            // The owner's own idle computer takes the turn.
            lane.admitted(chat, &on(lane.desktop)).await?;
            Ok(())
        },
    )
    .await
}

/// G8 and the one-active-turn index: one lane turn per person, across their
/// computers and chats, while it runs or may still start. A queued turn whose
/// start window passed still blocks until the sweep ends it, with a refusal
/// that says so; one whose lease ended blocks neither the gate nor the index.
#[tokio::test]
async fn one_lane_turn_per_person() -> anyhow::Result<()> {
    with_lane(
        "lane-one-turn",
        |_, _| {},
        |lane| async move {
            let first_chat = lane.chat().await?;
            let second_chat = lane.chat().await?;
            let owner = lane.owner();
            let first = lane
                .admitted(
                    first_chat,
                    &lane_send(lane.desktop, lane_metadata(json!({}))),
                )
                .await?;
            let second = lane_send(lane.second_desktop, lane_metadata(json!({})));
            let response = lane
                .refused(
                    &owner,
                    second_chat,
                    second.clone(),
                    (
                        StatusCode::CONFLICT,
                        claude_code_lane::TURN_ACTIVE,
                        "turn_active",
                    ),
                )
                .await?;
            assert!(response["message"]
                .as_str()
                .is_some_and(|text| !text.is_empty()));
            // Leased, it still blocks.
            sql(
                lane.pool(),
                "update agent_jobs set status = 'leased', lease_attempts = 1,
                    leased_by_runtime_id = target_runtime_id, leased_at = now(),
                    lease_expires_at = now() + interval '2 minutes'
              where id = $1",
                &[&first],
            )
            .await?;
            lane.refused(
                &owner,
                second_chat,
                second.clone(),
                (
                    StatusCode::CONFLICT,
                    claude_code_lane::TURN_ACTIVE,
                    "turn_active",
                ),
            )
            .await?;
            // Queued and never leased, past its start window.
            sql(
                lane.pool(),
                "update agent_jobs set status = 'queued', lease_attempts = 0,
                    leased_by_runtime_id = null, leased_at = null, lease_expires_at = null,
                    trigger_received_at = now() - interval '2 minutes'
              where id = $1",
                &[&first],
            )
            .await?;
            lane.refused(
                &owner,
                second_chat,
                second.clone(),
                (
                    StatusCode::CONFLICT,
                    claude_code_lane::TURN_ACTIVE,
                    claude_code_lane::START_WINDOW_PASSED,
                ),
            )
            .await?;
            // The index agrees: a second active lane row of the person's fails.
            let duplicate = sql(
                lane.pool(),
                "insert into agent_jobs (project_id, conversation_id, intent, status, payload,
                                     engine, trigger_received_at)
             select project_id, conversation_id, intent, 'queued', payload, engine, now()
               from agent_jobs where id = $1",
                &[&first],
            )
            .await
            .expect_err("a second active lane turn");
            let duplicate = duplicate
                .downcast_ref::<tokio_postgres::Error>()
                .expect("database error");
            assert!(
                claude_code_lane::is_second_active_turn(duplicate),
                "{duplicate}"
            );
            // Once a lease of it ended, it can never start again: neither the
            // gate nor the index counts it.
            sql(
                lane.pool(),
                "update agent_jobs set lease_attempts = 1 where id = $1",
                &[&first],
            )
            .await?;
            let next = lane.admitted(second_chat, &second).await?;
            assert_eq!(
                lane.job(next).await?.engine.as_deref(),
                Some(claude_code_lane::ENGINE)
            );
            // Another person's turn never counts against the owner's, and the
            // owner's never against theirs.
            let member_chat = lane.chat().await?;
            let (status, response) = lane
                .send(
                    &lane.token(lane.space().member),
                    member_chat,
                    &lane_send(lane.member_desktop, lane_metadata(json!({}))),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "member: {status} {response}");
            Ok(())
        },
    )
    .await
}

/// Two of a person's sends admitted at once, on two computers in two chats:
/// one turn starts and the other is refused as G8 refuses it, whichever way
/// their transactions interleave.
#[tokio::test]
async fn two_concurrent_admissions_start_one_turn() -> anyhow::Result<()> {
    with_lane(
        "lane-concurrent",
        |_, _| {},
        |lane| async move {
            let (first_chat, second_chat) = (lane.chat().await?, lane.chat().await?);
            let owner = lane.owner();
            let before = lane.written().await?;
            let first = lane_send(lane.desktop, lane_metadata(json!({})));
            let second = lane_send(lane.second_desktop, lane_metadata(json!({})));
            let (a, b) = tokio::join!(
                lane.send(&owner, first_chat, &first),
                lane.send(&owner, second_chat, &second),
            );
            let (a, b) = (a?, b?);
            let mut statuses = [a.0, b.0];
            statuses.sort();
            assert_eq!(
                statuses,
                [StatusCode::OK, StatusCode::CONFLICT],
                "{a:?} {b:?}"
            );
            let refused = if a.0 == StatusCode::CONFLICT {
                &a.1
            } else {
                &b.1
            };
            assert_eq!(
                refused["code"],
                json!(claude_code_lane::TURN_ACTIVE),
                "{refused}"
            );
            let after = lane.written().await?;
            assert_eq!(after.jobs, before.jobs + 1);
            assert_eq!(after.messages, before.messages + 1);
            Ok(())
        },
    )
    .await
}

/// The index settles two admissions that both passed G8: the second insert
/// waits for the first transaction, then fails with 23505, which
/// `enqueue_agent_job_record` answers as G8's own 409.
#[tokio::test]
async fn the_index_refuses_a_second_concurrent_insert_as_g8() -> anyhow::Result<()> {
    with_lane(
        "lane-index",
        |_, _| {},
        |lane| async move {
            let (first_chat, second_chat) = (lane.chat().await?, lane.chat().await?);
            let space = lane.space();
            let owner = person_context(space.owner);
            let lane_request = |chat: Uuid, runtime: Uuid| {
                lane.request(
                    &owner,
                    chat,
                    lane_send(runtime, without(lane_metadata(json!({})), &["turnEngine"])),
                    |request| {
                        request.claude_code_lane = Some(claude_code_lane::LaneAdmission {
                            runtime_id: runtime,
                        });
                    },
                )
            };
            let first_request = lane_request(first_chat, lane.desktop)?;
            let second_request = lane_request(second_chat, lane.second_desktop)?;

            let mut first_connection = lane.pool().get().await?;
            let first = first_connection.transaction().await?;
            let project = crate::load_project_record(&first, &space.project_id)
                .await
                .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.message))?;
            let (first_run, first_prompt) =
                insert_prompt_and_run(&first, &first_request, &owner).await?;
            let first_job = crate::agent::enqueue_agent_job_record(
                &first,
                &project,
                &owner,
                &first_request,
                &first_run,
                &first_prompt,
                Some(lane.desktop),
                None,
                None,
                None,
            )
            .await
            .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.message))?;
            assert!(first_job.is_some());

            let (pid_sender, pid_receiver) = tokio::sync::oneshot::channel::<i32>();
            let second_pool = lane.pool().clone();
            let second_project = project.clone();
            let second_owner = owner.clone();
            let second_runtime = lane.second_desktop;
            let second_insert = tokio::spawn(async move {
                let mut connection = second_pool.get().await?;
                let second = connection.transaction().await?;
                let pid: i32 = second
                    .query_one("select pg_backend_pid()", &[])
                    .await?
                    .get(0);
                let _ = pid_sender.send(pid);
                let (run, prompt) =
                    insert_prompt_and_run(&second, &second_request, &second_owner).await?;
                let outcome = crate::agent::enqueue_agent_job_record(
                    &second,
                    &second_project,
                    &second_owner,
                    &second_request,
                    &run,
                    &prompt,
                    Some(second_runtime),
                    None,
                    None,
                    None,
                )
                .await;
                anyhow::Ok(
                    outcome
                        .map(|_| ())
                        .map_err(|(status, Json(error))| (status, error)),
                )
            });
            let pid = pid_receiver.await?;
            eventually("the second insert to wait for the first", || async {
                let waiting: Option<String> = sql_one(
                    lane.pool(),
                    "select wait_event_type from pg_stat_activity where pid = $1",
                    &[&pid],
                )
                .await?;
                Ok((waiting.as_deref() == Some("Lock")).then_some(()))
            })
            .await?;
            first.commit().await?;
            let (status, error) = second_insert
                .await??
                .err()
                .ok_or_else(|| anyhow::anyhow!("the second insert was admitted"))?;
            assert_eq!(
                (status, error.code.as_deref(), reason_of(&error)),
                (
                    StatusCode::CONFLICT,
                    Some(claude_code_lane::TURN_ACTIVE),
                    Some("turn_active")
                ),
                "{}",
                error.message
            );
            let active: i64 = sql_one(
                lane.pool(),
                "select count(*) from agent_jobs where engine = 'claude-code'
                and payload ->> 'user_id' = $1",
                &[&space.owner.to_string()],
            )
            .await?;
            assert_eq!(active, 1);
            Ok(())
        },
    )
    .await
}

/// A prompt and a run for `request`, as dispatch inserts them before its job.
async fn insert_prompt_and_run(
    transaction: &tokio_postgres::Transaction<'_>,
    request: &DispatchPromptNormalized,
    context: &RequestContext,
) -> anyhow::Result<(Uuid, Uuid)> {
    let (run, prompt) = (Uuid::new_v4(), Uuid::new_v4());
    transaction
        .execute(
            "insert into prompts (id, project_id, conversation_id, user_id, intent, prompt_text,
                                  metadata)
             values ($1, $2, $3, $4, 'feature', $5, '{}'::jsonb)",
            &[
                &prompt,
                &request.project_id,
                &request.conversation_id,
                &context.user_id,
                &request.prompt_text,
            ],
        )
        .await?;
    transaction
        .execute(
            "insert into runs (id, project_id, conversation_id, prompt_id, run_type, status,
                               progress, progress_stage, metadata)
             values ($1, $2, $3, $4, 'prompt', 'queued', 0, 'agent:queued', '{}'::jsonb)",
            &[&run, &request.project_id, &request.conversation_id, &prompt],
        )
        .await?;
    Ok((run, prompt))
}

/// A claimed send never starts a conversation: the routes that create one
/// are refused in Stage 1, and a `POST /dispatch-prompt` that names a new
/// conversation id in Stage 2, whose conversation insert rolls back.
#[tokio::test]
async fn a_new_conversation_is_refused_and_rolled_back() -> anyhow::Result<()> {
    with_lane(
        "lane-new-chat",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = lane.owner();
            let body = lane_send(lane.desktop, lane_metadata(json!({})));
            lane.refused_at(
                &owner,
                format!("/projects/{}/conversations", space.project_id),
                body.clone(),
                not_person("new_conversation"),
            )
            .await?;
            let dispatch = with(
                body.clone(),
                json!({ "projectId": space.project_id.to_string() }),
            );
            lane.refused_at(
                &owner,
                "/dispatch-prompt".to_string(),
                dispatch.clone(),
                not_person("new_conversation"),
            )
            .await?;
            let named = Uuid::new_v4();
            lane.refused_at(
                &owner,
                "/dispatch-prompt".to_string(),
                with(
                    dispatch.clone(),
                    json!({ "conversationId": named.to_string() }),
                ),
                not_person("new_conversation"),
            )
            .await?;
            let kept: i64 = sql_one(
                lane.pool(),
                "select (select count(*) from conversations where id = $1)
                  + (select count(*) from conversation_participants where conversation_id = $1)",
                &[&named],
            )
            .await?;
            assert_eq!(kept, 0, "the conversation insert rolled back");
            // The same route to a conversation that exists takes the turn.
            let chat = lane.chat().await?;
            let (status, response) = lane
                .harness
                .call(
                    "POST",
                    "/dispatch-prompt",
                    Some(&owner),
                    Some(with(
                        dispatch,
                        json!({ "conversationId": chat.to_string() }),
                    )),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "dispatch: {status} {response}");
            let job = Uuid::parse_str(response["jobId"].as_str().unwrap_or_default())?;
            assert_eq!(
                lane.job(job).await?.engine.as_deref(),
                Some(claude_code_lane::ENGINE)
            );
            Ok(())
        },
    )
    .await
}

/// In a chat whose device grants name someone else, a claimed send is
/// refused before it is recorded, where an ordinary one would be recorded and
/// start nothing. The grant's own person's lane turn there holds no grant.
#[tokio::test]
async fn a_granted_chat_refuses_someone_elses_claim_before_recording_it() -> anyhow::Result<()> {
    with_lane(
        "lane-granted-chat",
        |config, space| config.device_grants = DeviceGrantUsers::Only(vec![space.member]),
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let member_octo = {
                let mut connection = lane.pool().get().await?;
                let transaction = connection.transaction().await?;
                let profile = crate::ai_agents::load_or_create_octo_agent_profile(
                    &transaction,
                    &space.member,
                )
                .await
                .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.message))?;
                transaction.commit().await?;
                profile.id
            };
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

            lane.refused(
                &lane.owner(),
                chat,
                lane_send(lane.desktop, lane_metadata(json!({}))),
                (
                    StatusCode::CONFLICT,
                    claude_code_lane::CONVERSATION_GRANTED,
                    "conversation_granted",
                ),
            )
            .await?;
            // The same send without the claim is recorded and starts nothing.
            let before = lane.written().await?;
            let (status, response) = lane
                .send(
                    &lane.owner(),
                    chat,
                    &lane_send(
                        lane.desktop,
                        without(lane_metadata(json!({})), &["turnEngine"]),
                    ),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            assert_eq!(response["status"], json!("recorded"));
            assert_eq!(lane.written().await?.messages, before.messages + 1);

            // The grant's own person: a lane turn, holding no grant.
            let member = lane.token(space.member);
            let (status, response) = lane
                .send(
                    &member,
                    chat,
                    &lane_send(lane.member_desktop, lane_metadata(json!({}))),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "member: {status} {response}");
            let job = lane
                .job(Uuid::parse_str(
                    response["jobId"].as_str().unwrap_or_default(),
                )?)
                .await?;
            assert_eq!(job.engine.as_deref(), Some(claude_code_lane::ENGINE));
            assert_eq!(job.grant_ids, None);
            // Their ordinary turn there holds it, as before.
            lane.end_jobs().await?;
            let (status, response) = lane
                .send(
                    &member,
                    chat,
                    &lane_send(
                        lane.member_desktop,
                        without(lane_metadata(json!({})), &["turnEngine"]),
                    ),
                )
                .await?;
            anyhow::ensure!(
                status == StatusCode::OK,
                "member codex: {status} {response}"
            );
            let job = lane
                .job(Uuid::parse_str(
                    response["jobId"].as_str().unwrap_or_default(),
                )?)
                .await?;
            assert_eq!(job.engine, None);
            assert_eq!(job.grant_ids, Some(vec![grant]));
            Ok(())
        },
    )
    .await
}

/// A claimed send to a chat whose @octo is busy gets the busy chat's own 409,
/// whether or not it asked for the idle check, and is never queued instead.
#[tokio::test]
async fn a_busy_chat_refuses_a_claim_and_never_queues_it() -> anyhow::Result<()> {
    with_lane(
        "lane-busy-chat",
        |_, _| {},
        |lane| async move {
            let chat = lane.chat().await?;
            let owner = lane.owner();
            // An ordinary turn of @octo's, on another computer.
            lane.admitted(
                chat,
                &json!({
                    "promptText": "Read the logs.",
                    "intent": "feature",
                    "runtimeId": lane.space().runtime.to_string(),
                    "metadata": without(lane_metadata(json!({})), &["turnEngine"]),
                }),
            )
            .await?;
            for expected_idle in [true, false] {
                let before = lane.written().await?;
                let body = with(
                    lane_send(lane.desktop, lane_metadata(json!({}))),
                    json!({ "expectedLaneIdle": expected_idle }),
                );
                let (status, response) = lane.send(&owner, chat, &body).await?;
                assert_eq!(status, StatusCode::CONFLICT, "{response}");
                assert_eq!(response["code"], json!("dispatch_lane_busy"), "{response}");
                assert_eq!(lane.written().await?, before, "nothing written or queued");
            }
            // An ordinary send there is still queued.
            let before = lane.written().await?;
            let (status, response) = lane
                .send(
                    &owner,
                    chat,
                    &json!({
                        "promptText": "And the next thing.",
                        "intent": "feature",
                        "expectedLaneIdle": true,
                        "metadata": without(lane_metadata(json!({})), &["turnEngine"]),
                    }),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
            assert_eq!(response["status"], json!("queued"));
            assert_eq!(lane.written().await?.queued, before.queued + 1);
            Ok(())
        },
    )
    .await
}

/// Intake: the claim is taken from every caller, the service role included,
/// and only `claude-code` claims the lane; anything else is a 400 that writes
/// nothing. Both spellings are the claim.
#[tokio::test]
async fn the_claim_is_taken_from_every_caller() -> anyhow::Result<()> {
    with_lane(
        "lane-intake",
        |_, _| {},
        |lane| async move {
            let chat = lane.chat().await?;
            let owner = lane.owner();
            let unknown = (
                StatusCode::BAD_REQUEST,
                claude_code_lane::TURN_ENGINE_UNKNOWN,
                "unknown_engine",
            );
            for (token, value) in [
                (owner.as_str(), json!("codex")),
                (owner.as_str(), json!(null)),
                (owner.as_str(), json!("CLAUDE-CODE")),
                (SERVICE_ROLE, json!("codex")),
            ] {
                lane.refused(
                    token,
                    chat,
                    lane_send(lane.desktop, lane_metadata(json!({ "turnEngine": value }))),
                    unknown,
                )
                .await?;
            }
            // The other spelling claims the lane too.
            lane.refused(
                &lane.token(lane.space().guest),
                chat,
                lane_send(
                    lane.desktop,
                    without(
                        lane_metadata(json!({ "turn_engine": "claude-code" })),
                        &["turnEngine"],
                    ),
                ),
                not_allowed("not_allowed"),
            )
            .await?;
            Ok(())
        },
    )
    .await
}

/// The claim never rides a queue entry or an automation: the queue refuses
/// one to enqueue or to restore an edit, and automations refuse one in their
/// prompt metadata on create and update. Dispatch refuses an automation's run
/// that carries one from before, which has no trigger.
#[tokio::test]
async fn a_claim_never_rides_a_queue_entry_or_an_automation() -> anyhow::Result<()> {
    with_lane(
        "lane-queue-automation",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let owner = lane.owner();
            let claimed = lane_send(lane.desktop, lane_metadata(json!({})));
            lane.refused_at(
                &owner,
                format!("/conversations/{chat}/send-queue"),
                json!({ "message": claimed, "clientSendId": Uuid::new_v4().to_string() }),
                not_person("queued"),
            )
            .await?;
            lane.refused_at(
                &owner,
                format!(
                    "/conversations/{chat}/send-queue/{}/restore",
                    Uuid::new_v4()
                ),
                json!({
                    "expectedUpdatedAt": Utc::now().to_rfc3339(),
                    "message": claimed,
                    "targetAgentHandles": ["octo"],
                }),
                not_person("queued"),
            )
            .await?;

            let automation = json!({
                "name": "Nightly build check",
                "scheduleKind": "hourly",
                "promptText": WORDS,
                "status": "paused",
            });
            lane.refused_at(
                &owner,
                format!("/projects/{}/automations", space.project_id),
                with(
                    automation.clone(),
                    json!({ "metadata": { "turnEngine": "claude-code" } }),
                ),
                not_person("automation"),
            )
            .await?;
            let (status, created) = lane
                .harness
                .call(
                    "POST",
                    format!("/projects/{}/automations", space.project_id),
                    Some(&owner),
                    Some(automation),
                )
                .await?;
            anyhow::ensure!(status == StatusCode::OK, "create: {status} {created}");
            let automation_id = created["id"].as_str().unwrap_or_default().to_string();
            let (status, updated) = lane
                .harness
                .call(
                    "PATCH",
                    format!("/automations/{automation_id}"),
                    Some(&owner),
                    Some(json!({ "metadata": { "turn_engine": "claude-code" } })),
                )
                .await?;
            assert_eq!(
                (
                    status,
                    updated["code"].as_str(),
                    updated["details"]["reason"].as_str()
                ),
                (
                    StatusCode::FORBIDDEN,
                    Some(claude_code_lane::TURN_NOT_PERSON),
                    Some("automation")
                ),
                "{updated}"
            );
            let stored = lane
                .metadata_of(
                    "select metadata from automations where id = $1",
                    Uuid::parse_str(&automation_id)?,
                )
                .await?;
            assert_never_holds(&stored, &["turnEngine", "turn_engine"], "automation");
            // An automation's run, as automations dispatch it.
            lane.refused_directly(
                person_context(space.owner),
                chat,
                claimed,
                |request| {
                    request.trigger = None;
                    request.thread_kind = Some("automation".to_string());
                    request.allow_silent_automation_decline = true;
                },
                not_person("not_own_session"),
            )
            .await?;
            Ok(())
        },
    )
    .await
}

/// A client's copy of the controller's lane stamps never persists: dispatch
/// drops it from an ordinary send, and recording a message drops it and the
/// claim, for the service role too.
#[tokio::test]
async fn a_clients_lane_stamps_never_persist() -> anyhow::Result<()> {
    with_lane(
        "lane-stamps",
        |_, _| {},
        |lane| async move {
            let chat = lane.chat().await?;
            let owner = lane.owner();
            let forged = json!({
                "claudeCode": { "version": 1 },
                "claude_code": { "version": 1 },
                "claudeCodeFailure": "plan_limit",
                "prompt_metadata": { "claudeCode": { "version": 1 }, "turnEngine": "claude-code" },
            });
            let job = lane
                .admitted(
                    chat,
                    &lane_send(
                        lane.desktop,
                        without(lane_metadata(forged.clone()), &["turnEngine"]),
                    ),
                )
                .await?;
            let job = lane.job(job).await?;
            assert_eq!(job.engine, None);
            assert_eq!(job.payload["metadata"]["aiAccessMode"], json!("byoc"));
            let run_id = job.run_id.expect("run");
            let message = lane
            .metadata_of(
                "select metadata from conversation_messages where run_id = $1 and role = 'user'",
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
                assert_never_holds(
                    value,
                    &[
                        "claudeCode",
                        "claude_code",
                        "claudeCodeFailure",
                        "turnEngine",
                    ],
                    what,
                );
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
                                "turnEngine": "claude-code",
                                "turn_engine": "claude-code",
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
                assert_never_holds(
                    &stored,
                    &[
                        "claudeCode",
                        "claude_code",
                        "claudeCodeFailure",
                        "turnEngine",
                        "turn_engine",
                    ],
                    token,
                );
            }
            Ok(())
        },
    )
    .await
}

/// A claimed send in a group chat is never turned into an evaluation and
/// gets no preamble, where the same send without the claim is one.
#[tokio::test]
async fn a_claimed_group_send_is_never_an_evaluation() -> anyhow::Result<()> {
    with_lane(
        "lane-group-chat",
        |_, _| {},
        |lane| async move {
            let ambient = json!({ "agentSelection": { "active": ["octo"], "mentions": [] } });
            let codex_chat = lane.chat().await?;
            let codex = lane
                .admitted(
                    codex_chat,
                    &json!({
                        "promptText": WORDS,
                        "intent": "feature",
                        "runtimeId": lane.space().runtime.to_string(),
                        "metadata": without(lane_metadata(ambient.clone()), &["turnEngine"]),
                    }),
                )
                .await?;
            let codex = lane.job(codex).await?;
            assert!(
                crate::group_participation::job_payload_marks_agent_evaluation(&codex.payload),
                "the chat is a group chat: {}",
                codex.payload
            );
            assert_ne!(codex.payload["prompt_text"], json!(WORDS));

            let chat = lane.chat().await?;
            let job = lane
                .admitted(chat, &lane_send(lane.desktop, lane_metadata(ambient)))
                .await?;
            let job = lane.job(job).await?;
            assert_eq!(job.engine.as_deref(), Some(claude_code_lane::ENGINE));
            assert!(!crate::group_participation::job_payload_marks_agent_evaluation(&job.payload));
            assert_eq!(job.payload["prompt_text"], json!(WORDS));
            let message = lane
            .metadata_of(
                "select metadata from conversation_messages where run_id = $1 and role = 'user'",
                job.run_id.expect("run"),
            )
            .await?;
            assert_never_holds(
                &message,
                &["groupParticipation", "groupAiParticipants"],
                "message",
            );
            Ok(())
        },
    )
    .await
}

/// JobTrigger: a person on the lane list gets a kind for their own typed
/// message, a resend gets none, and someone off the list none. Device grants
/// stay off for someone only on the lane list.
#[tokio::test]
async fn lane_users_get_a_kind_and_never_device_grants() -> anyhow::Result<()> {
    with_lane("lane-trigger", |_, _| {}, |lane| async move {
        let space = lane.space();
        let typed = |extra: JsonValue| {
            json!({
                "promptText": "@helper look at the door",
                "intent": "feature",
                "metadata": with(json!({
                    "clientMessageId": Uuid::new_v4().to_string(),
                    "agentSelection": { "active": [], "mentions": ["helper"] },
                    "input": { "kind": "person" },
                }), extra),
            })
        };
        let lane = &lane;
        let kind_of = |job: Uuid| async move {
            let job = lane.job(job).await?;
            let message = lane
                .metadata_of(
                    "select metadata from conversation_messages where run_id = $1 and role = 'user'",
                    job.run_id.expect("run"),
                )
                .await?;
            anyhow::Ok((message.get("trigger").cloned(), job))
        };
        let (kind, job) = kind_of(lane.admitted(space.log, &typed(json!({}))).await?).await?;
        assert_eq!(kind, Some(json!("person")));
        assert_eq!(job.grant_ids, None);
        lane.end_jobs().await?;
        let resent = typed(json!({ "retryOfMessageId": Uuid::new_v4().to_string() }));
        let (kind, _) = kind_of(lane.admitted(space.log, &resent).await?).await?;
        assert_eq!(kind, None);
        lane.end_jobs().await?;
        let (status, response) = lane
            .send(&lane.token(space.guest), space.log, &typed(json!({})))
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "{status} {response}");
        let guest_job = Uuid::parse_str(response["jobId"].as_str().unwrap_or_default())?;
        let (kind, _) = kind_of(guest_job).await?;
        assert_eq!(kind, None);
        lane.end_jobs().await?;

        // Device grants are still off for the owner: the routes answer 404,
        // and a grant left in the conversation gives their turn nothing.
        let (status, _) = lane
            .harness
            .call(
                "GET",
                format!("/projects/{}/device-grants", space.project_id),
                Some(&lane.owner()),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
        sql(
            lane.pool(),
            "insert into project_provider_devices (
                 project_id, provider_id, provider_family_id, device_id, owner_user_id
             ) values ($1, $2, $2, $3, $4)",
            &[&space.project_id, &DEVICE_PROVIDER, &DEVICE, &space.owner],
        )
        .await?;
        sql(
            lane.pool(),
            "insert into agent_device_grants (
                 id, project_id, user_id, agent_id, provider_id, device_id, tool_ids,
                 conversation_id, not_before
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 hour')",
            &[
                &Uuid::new_v4(),
                &space.project_id,
                &space.owner,
                &space.owner_agent,
                &DEVICE_PROVIDER,
                &DEVICE,
                &vec!["device.state.read".to_string()],
                &space.log,
            ],
        )
        .await?;
        let (kind, job) = kind_of(lane.admitted(space.log, &typed(json!({}))).await?).await?;
        assert_eq!(kind, Some(json!("person")));
        assert_eq!(job.grant_ids, None);
        Ok(())
    })
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
            let parent = lane.busy_job(lane.space().other_machine, false).await?;
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

/// The builders of a lane job's payload and of its reply: the reply is
/// stamped as a lane turn's, and a lane payload never carries an evaluation.
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
    let project = crate::ProjectRecord {
        id: Uuid::new_v4(),
        org_id: None,
        name: None,
        sandbox_session_id: None,
        project_type: None,
        owner_user_id: Some(user),
        _status: None,
    };
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
    assert_ne!(evaluation["prompt_text"], json!(WORDS), "the preamble");
    request.claude_code_lane = Some(claude_code_lane::LaneAdmission {
        runtime_id: Uuid::new_v4(),
    });
    let (status, _) =
        crate::agent::build_agent_job_payload(&project, &context, &request, &run, &prompt, None)
            .expect_err("a lane evaluation");
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
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

/// Lease (docs/Local-Engine-Turns.md 2.4): only the computer a lane turn was
/// admitted on leases it, while it attests the turn's person as its owner
/// and a ready `claudeCode`: never a hosted runtime that reports the
/// capability, even pinned to it, the person's other computer, a teammate's
/// or a Personal Browser runtime. The lease adds no envelope, metering bind,
/// job token, history or extras, and keeps the internal workspace token. A
/// lane turn is leased once, and never after its minute to start.
#[tokio::test]
async fn only_its_own_ready_computer_leases_a_lane_turn_once() -> anyhow::Result<()> {
    with_lane(
        "lane-lease",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (_, job) = lane.lane_turn(lane.desktop).await?;
            let hosted = lane
                .computer(
                    "instafy-cloud",
                    capabilities(None, lane_ready()),
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
                lane.second_desktop,
                lane.member_desktop,
                personal_browser,
                space.runtime,
            ] {
                lane.leases_nothing(runtime, "another computer").await?;
            }
            // Pinned to any of them, none leases it either. A hosted runtime
            // has no owner filter: the lease's own clause keeps it out.
            for runtime in [hosted, lane.member_desktop, personal_browser, space.runtime] {
                lane.pin(job, runtime).await?;
                lane.leases_nothing(runtime, "pinned there").await?;
            }
            lane.pin(job, lane.desktop).await?;
            // Its own computer does not either, once it no longer attests a
            // ready capability of version 1, or its person as its owner.
            for (what, attested) in [
                (
                    "not ready",
                    capabilities(
                        Some(space.owner),
                        json!({ "claudeCode": { "version": 1, "ready": false } }),
                    ),
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

            // Leased once: put back in the queue, as the idle release puts
            // back an expired lease, no lease hands it out again.
            sql(
                lane.pool(),
                "update agent_jobs set status = 'queued', leased_by_runtime_id = null,
                        leased_at = null, lease_expires_at = null
                  where id = $1",
                &[&job],
            )
            .await?;
            lane.leases_nothing(lane.desktop, "leased once").await?;

            // Never after its minute to start.
            lane.end_jobs().await?;
            let (_, late) = lane.lane_turn(lane.desktop).await?;
            sql(
                lane.pool(),
                "update agent_jobs set trigger_received_at = now() - interval '61 seconds'
                  where id = $1",
                &[&late],
            )
            .await?;
            lane.leases_nothing(lane.desktop, "past its minute").await?;
            Ok(())
        },
    )
    .await
}

/// A lane turn is never batched: it is never a batch's second job, and a
/// batch ends after it, whatever else its computer could lease.
#[tokio::test]
async fn a_lane_turn_is_never_batched() -> anyhow::Result<()> {
    with_lane(
        "lane-batch",
        |_, _| {},
        |lane| async move {
            let (_, job) = lane.lane_turn(lane.desktop).await?;
            // A read-only job of a team's plan, ahead of it for the same
            // computer: the batch it starts takes only its plan's read-only
            // jobs.
            let other_chat = lane.chat().await?;
            let ahead = lane
                .queue_codex_job(
                    lane.desktop,
                    other_chat,
                    0,
                    json!({
                        "writeScope": { "mode": "read_only" },
                        "multiAgentPlan": { "groupId": Uuid::new_v4().to_string() },
                    }),
                )
                .await?;
            lane.lease_one(lane.desktop, ahead).await?;
            lane.lease_one(lane.desktop, job).await?;

            // Leased first, it ends its batch though its computer could
            // lease another job.
            lane.end_jobs().await?;
            let (_, job) = lane.lane_turn(lane.desktop).await?;
            let behind = lane
                .queue_codex_job(lane.desktop, other_chat, 200, json!({}))
                .await?;
            lane.lease_one(lane.desktop, job).await?;
            lane.lease_one(lane.desktop, behind).await?;
            Ok(())
        },
    )
    .await
}

/// An expired lane lease, in a space that is still active, is never renewed
/// or leased again: a heartbeat on it gets a 409, and the 10 s sweep fails
/// the turn as `run_once_interrupted`, with the message its author's Studio
/// words.
#[tokio::test]
async fn an_expired_lane_lease_ends_its_turn_for_good() -> anyhow::Result<()> {
    with_lane(
        "lane-expired-lease",
        |_, _| {},
        |lane| async move {
            let (_, job) = lane.lane_turn(lane.desktop).await?;
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
            lane.leases_nothing(lane.desktop, "an ended turn").await?;
            Ok(())
        },
    )
    .await
}

/// The run-once sweep fails a lane turn that can no longer start: past its
/// minute as `start_by_passed`, and put back in the queue after a lease as
/// `run_once_interrupted`, each with the message its author's Studio words.
/// G8 and the one-active-turn index agree on a queued turn past its minute:
/// both count it until the sweep fails it, and neither does after.
#[tokio::test]
async fn the_run_once_sweep_fails_a_lane_turn_that_can_no_longer_start() -> anyhow::Result<()> {
    with_lane(
        "lane-run-once-sweep",
        |_, _| {},
        |lane| async move {
            let owner = lane.owner();
            let (_, late) = lane.lane_turn(lane.desktop).await?;
            sql(
                lane.pool(),
                "update agent_jobs set trigger_received_at = now() - interval '61 seconds'
                  where id = $1",
                &[&late],
            )
            .await?;
            let next_chat = lane.chat().await?;
            let next = lane_send(lane.second_desktop, lane_metadata(json!({})));
            lane.refused(
                &owner,
                next_chat,
                next.clone(),
                (
                    StatusCode::CONFLICT,
                    claude_code_lane::TURN_ACTIVE,
                    claude_code_lane::START_WINDOW_PASSED,
                ),
            )
            .await?;
            let duplicate = sql(
                lane.pool(),
                "insert into agent_jobs (project_id, conversation_id, intent, status, payload,
                                         engine, trigger_received_at)
                 select project_id, conversation_id, intent, 'queued', payload, engine, now()
                   from agent_jobs where id = $1",
                &[&late],
            )
            .await
            .expect_err("the index counts it too");
            let duplicate = duplicate
                .downcast_ref::<tokio_postgres::Error>()
                .expect("database error");
            assert!(
                claude_code_lane::is_second_active_turn(duplicate),
                "{duplicate}"
            );

            lane.sweep_while_active().await?;
            let (status, error, _) = lane.ended(late).await?;
            assert_eq!(status, "failed");
            assert!(
                error
                    .as_deref()
                    .is_some_and(|error| error.contains("start by a set time")),
                "{error:?}"
            );
            let run = lane.job(late).await?.run_id.expect("run");
            assert_eq!(lane.run_status(run).await?, "failed");
            let (_, metadata) = lane.failure_message(run).await?;
            assert_eq!(metadata["kind"], json!("start_by_passed"));
            assert_lane_failure(&metadata, "start_by_passed", "past its minute");

            // Neither G8 nor the index counts it now.
            let interrupted = lane.admitted(next_chat, &next).await?;
            lane.lease_one(lane.second_desktop, interrupted).await?;
            sql(
                lane.pool(),
                "update agent_jobs set status = 'queued', leased_by_runtime_id = null,
                        leased_at = null, lease_expires_at = null
                  where id = $1",
                &[&interrupted],
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
            let (_, metadata) = lane.failure_message(run).await?;
            assert_eq!(metadata["kind"], json!("run_once_interrupted"));
            assert_lane_failure(&metadata, "run_once_interrupted", "put back after a lease");
            Ok(())
        },
    )
    .await
}

/// A runtime stop fails a lane turn, queued or leased, as
/// `claude_code_machine_stopped`: it keeps its pin, its run fails and its
/// message carries what its author's Studio words it by. The stop requeues
/// the computer's other work as before, and none of the lane turn.
#[tokio::test]
async fn a_runtime_stop_fails_a_lane_turn_and_requeues_none_of_it() -> anyhow::Result<()> {
    with_lane(
        "lane-runtime-stop",
        |_, _| {},
        |lane| async move {
            let (_, queued) = lane.lane_turn(lane.desktop).await?;
            let codex_chat = lane.chat().await?;
            let codex = lane
                .admitted(
                    codex_chat,
                    &json!({
                        "promptText": "Read the logs.",
                        "intent": "feature",
                        "runtimeId": lane.desktop.to_string(),
                        "metadata": without(lane_metadata(json!({})), &["turnEngine"]),
                    }),
                )
                .await?;
            let (requeued, failed) = lane.stop_runtime(lane.desktop).await?;
            assert_eq!(requeued, vec![codex]);
            assert_eq!(failed, vec![(queued, true)], "failed with a message");
            let job = lane.job(queued).await?;
            assert_eq!(job.status, "failed");
            assert_eq!(job.target_runtime_id, Some(lane.desktop), "never unpinned");
            let run = job.run_id.expect("run");
            assert_eq!(lane.run_status(run).await?, "failed");
            let (content, metadata) = lane.failure_message(run).await?;
            assert_eq!(content, claude_code_lane::MACHINE_STOPPED_MESSAGE);
            assert_eq!(metadata["kind"], json!(claude_code_lane::MACHINE_STOPPED));
            assert_lane_failure(&metadata, claude_code_lane::MACHINE_STOPPED, "queued");

            // Leased, it fails the same way.
            lane.end_jobs().await?;
            let (_, leased) = lane.lane_turn(lane.desktop).await?;
            lane.lease_one(lane.desktop, leased).await?;
            let (requeued, failed) = lane.stop_runtime(lane.desktop).await?;
            assert!(requeued.is_empty(), "{requeued:?}");
            assert_eq!(failed, vec![(leased, true)]);
            let (status, error, _) = lane.ended(leased).await?;
            assert_eq!(status, "failed");
            assert_eq!(
                error.as_deref(),
                Some(claude_code_lane::MACHINE_STOPPED_MESSAGE)
            );
            let run = lane.job(leased).await?.run_id.expect("run");
            let (_, metadata) = lane.failure_message(run).await?;
            assert_lane_failure(&metadata, claude_code_lane::MACHINE_STOPPED, "leased");
            Ok(())
        },
    )
    .await
}

/// The paths that take a job with no credential for Instafy AI, or run a
/// failed turn again, ignore a lane turn: the stranded-platform sweep leaves
/// it queued, a short rate limit fails it rather than put it back in the
/// queue, and its end teaches the upstream pacing nothing.
#[tokio::test]
async fn platform_sweeps_retries_and_pacing_ignore_a_lane_turn() -> anyhow::Result<()> {
    with_lane(
        "lane-platform-paths",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let (_, job) = lane.lane_turn(lane.desktop).await?;
            // Queued for longer than the stranded-platform grace, on a private
            // computer, with no credential, and within its minute to start.
            sql(
                lane.pool(),
                "update agent_jobs set created_at = now() - interval '5 minutes' where id = $1",
                &[&job],
            )
            .await?;
            lane.sweep_while_active().await?;
            assert_eq!(lane.job(job).await?.status, "queued");

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
            let (chat, job) = lane.lane_turn(lane.desktop).await?;
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
            let (_, job) = lane.lane_turn(lane.desktop).await?;
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
                let (_, failed) = lane.lane_turn(lane.desktop).await?;
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
            let codex = lane
                .admitted(
                    codex_chat,
                    &json!({
                        "promptText": "Read the logs.",
                        "intent": "feature",
                        "runtimeId": space.runtime.to_string(),
                        "metadata": without(lane_metadata(json!({})), &["turnEngine"]),
                    }),
                )
                .await?;
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

/// The next lane turn resumes only its own engine's session: its sender's,
/// with the same agent, in the same chat, on the computer it was admitted
/// on. A turn that saved no state, such as a stopped one, is passed over, and
/// a reset starts a new session. The Codex loader never returns lane state.
#[tokio::test]
async fn a_lane_turn_resumes_only_its_own_session() -> anyhow::Result<()> {
    with_lane(
        "lane-resume",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chat = lane.chat().await?;
            let send = |runtime: Uuid| lane_send(runtime, lane_metadata(json!({})));
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
            let session = Uuid::new_v4();
            let first = lane.admitted(chat, &send(lane.desktop)).await?;
            assert_eq!(state_of(first).await?, None, "a first turn starts a session");
            let octo = lane.job(first).await?.payload["metadata"]["agent"]["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                .expect("the sender's @octo");
            lane.lease_one(lane.desktop, first).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    first,
                    json!({
                        "outcome": "succeeded",
                        "summary": "Done.",
                        "proxy_metadata": { "conversation": lane_session(lane.desktop, session) },
                    }),
                )
                .await?;

            // The loader keeps to the person, agent, chat and computer.
            {
                let mut connection = lane.pool().get().await?;
                let transaction = connection.transaction().await?;
                let load = |conversation: Uuid, sender: Uuid, agent: Uuid, runtime: Uuid| {
                    let transaction = &transaction;
                    let project = space.project_id;
                    async move {
                        claude_code_lane::load_session(
                            transaction,
                            &project,
                            &conversation,
                            &sender,
                            Some(&agent),
                            &runtime,
                        )
                        .await
                        .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.message))
                    }
                };
                assert_eq!(
                    load(chat, space.owner, octo, lane.desktop).await?,
                    Some(lane_session(lane.desktop, session))
                );
                for (what, conversation, sender, agent, runtime) in [
                    ("another chat", space.log, space.owner, octo, lane.desktop),
                    ("another person", chat, space.member, octo, lane.desktop),
                    ("another agent", chat, space.owner, space.owner_agent, lane.desktop),
                    ("another computer", chat, space.owner, octo, lane.second_desktop),
                ] {
                    assert_eq!(
                        load(conversation, sender, agent, runtime).await?,
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
                    json!(octo.to_string()),
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
                    Some(&octo),
                    Some("octo"),
                    None,
                )
                .await
                .map_err(|(status, error)| anyhow::anyhow!("{status} {}", error.message))?;
                assert_eq!(codex_state, None);
                transaction.rollback().await?;
            }

            // The next turn resumes the session.
            let second = lane.admitted(chat, &send(lane.desktop)).await?;
            assert_eq!(
                state_of(second).await?,
                Some(lane_session(lane.desktop, session))
            );
            // Stopped, it saves nothing: the turn after it resumes the same
            // session.
            lane.lease_one(lane.desktop, second).await?;
            let (status, body) = lane
                .harness
                .call(
                    "POST",
                    format!("/jobs/{second}/cancel"),
                    Some(&lane.owner()),
                    Some(json!({})),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            // On the person's other computer it starts a new session.
            let elsewhere = lane.admitted(chat, &send(lane.second_desktop)).await?;
            assert_eq!(state_of(elsewhere).await?, None, "another computer");
            lane.end_jobs().await?;
            let third = lane.admitted(chat, &send(lane.desktop)).await?;
            assert_eq!(
                state_of(third).await?,
                Some(lane_session(lane.desktop, session)),
                "a stopped turn and another computer's turn are passed over"
            );

            // A resume that missed resets it: the next turn starts afresh.
            lane.lease_one(lane.desktop, third).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    third,
                    json!({
                        "outcome": "failed",
                        "error_message": "No conversation found with that session ID.",
                        "proxy_metadata": { "conversation": {
                            "provider": "claude-code", "version": 1, "reset": true,
                        } },
                        "artifacts": [{ "kind": "claude-code/failure", "code": "session_unavailable" }],
                    }),
                )
                .await?;
            let fourth = lane.admitted(chat, &send(lane.desktop)).await?;
            assert_eq!(state_of(fourth).await?, None, "a reset starts a new session");
            Ok(())
        },
    )
    .await
}
