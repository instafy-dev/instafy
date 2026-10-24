#![cfg(test)]

// What started an agent job, on the migrated database: the message routes,
// the send queue and automations record it from the caller's own credential,
// and a message says what made it only where device grants are on for its
// sender. Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use axum::http::StatusCode;
use axum::Router;
use chrono::{DateTime, Utc};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::dispatch::{self, DispatchPromptNormalized, DispatchPromptRequest};
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, require_origin_test_pool,
    sql, test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::AppState;

pub(crate) const DEVICE_ID: &str = "device-1";

/// An org whose space has an owner and another member, each with an agent
/// called `helper`, and a self-hosted machine of the owner's.
pub(crate) struct Space {
    pub(crate) org_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) owner: Uuid,
    pub(crate) member: Uuid,
    /// A conversation everyone in the space reads.
    pub(crate) log: Uuid,
    pub(crate) runtime: Uuid,
}

impl Space {
    fn new() -> Self {
        Self {
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            owner: Uuid::new_v4(),
            member: Uuid::new_v4(),
            log: Uuid::new_v4(),
            runtime: Uuid::new_v4(),
        }
    }

    async fn seed(&self, pool: &PgPool, label: &str) -> anyhow::Result<()> {
        for user in [self.owner, self.member] {
            ensure_test_user(pool, &user).await?;
        }
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
                &[&self.org_id, &self.owner, &self.member],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, $3, $4, 'customer', 'active')",
                &[&self.project_id, &self.org_id, &label, &self.owner],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&self.project_id, &self.member],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&self.org_id, &self.project_id],
            )
            .await?;
        for user in [self.owner, self.member] {
            let credential_id = Uuid::new_v4();
            connection
                .execute(
                    "insert into user_credentials (
                         id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                     ) values ($1, $2, 'openai_api_key', 'Trigger test', 'test-nonce',
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
                    &[&Uuid::new_v4(), &user, &credential_id],
                )
                .await?;
        }
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, metadata, visibility)
                 values ($1, $2, $3, '{}'::jsonb, 'public')",
                &[&self.log, &self.project_id, &self.owner],
            )
            .await?;
        let mut capabilities = json!({ "agent": true, "origin": true });
        crate::runtime::set_self_hosted_access_attestation(
            capabilities.as_object_mut().expect("capabilities"),
            self.owner,
        );
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, idle_ttl_seconds, last_seen_at, capabilities
                 ) values ($1, $2, 'self-hosted', 'ready', 600, now(), $3)",
                &[&self.runtime, &self.project_id, &PgJson(capabilities)],
            )
            .await?;
        Ok(())
    }
}

/// `grants` turns device grants on, for the space's people only.
fn config(label: &str, space: &Space, grants: bool) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.device_grants_enabled = grants;
    config.device_grants_user_ids = vec![space.owner, space.member];
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
    config
}

/// Device grants are on only with `DEVICE_GRANTS_ENABLED`, and then for every
/// user under `DEV_MODE` and otherwise only for `DEVICE_GRANTS_USER_IDS`.
#[test]
fn grants_exist_only_with_the_flag_and_dev_mode_or_the_allowlist() {
    let space = Space::new();
    let allows = |grants: bool, dev_mode: bool, listed: bool, user: Uuid| {
        let mut config = config("device-grants-allow", &space, grants);
        config.dev_mode = dev_mode;
        if !listed {
            config.device_grants_user_ids.clear();
        }
        config.device_grants_allow(user)
    };
    let other = Uuid::new_v4();
    assert!(!allows(false, true, true, space.owner));
    assert!(!allows(true, false, false, space.owner));
    assert!(allows(true, false, true, space.owner));
    assert!(!allows(true, false, true, other));
    assert!(allows(true, true, false, other));
}

pub(crate) struct Harness {
    pub(crate) pool: PgPool,
    pub(crate) state: AppState,
    pub(crate) app: Router,
    pub(crate) space: Space,
}

impl Harness {
    pub(crate) fn token(&self, user: Uuid) -> String {
        crate::auth::issue_controller_token(&self.state.config, &user)
            .expect("user token")
            .token
    }

    pub(crate) async fn call(
        &self,
        method: &str,
        path: impl Into<String>,
        token: Option<&str>,
        body: Option<JsonValue>,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let auth = token.map(|token| format!("Bearer {token}"));
        call_router(&self.app, auth.as_deref(), method, path.into(), body).await
    }

    /// `token`'s holder sends a prompt to their `helper` agent through the
    /// message route, and gets the job it started.
    async fn send_as(
        &self,
        token: &str,
        conversation: Uuid,
        extra_metadata: JsonValue,
    ) -> anyhow::Result<SentJob> {
        let (status, body) = self
            .call(
                "POST",
                format!("/conversations/{conversation}/messages"),
                Some(token),
                Some(json!({
                    "promptText": "@helper look at the door",
                    "intent": "feature",
                    "metadata": prompt_metadata(extra_metadata),
                })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "send: {status} {body}");
        let run_id = Uuid::parse_str(body["runId"].as_str().unwrap_or_default())
            .map_err(|_| anyhow::anyhow!("send started no run: {body}"))?;
        job_of_run(&self.pool, run_id).await
    }

    pub(crate) async fn send(
        &self,
        user: Uuid,
        conversation: Uuid,
        extra_metadata: JsonValue,
    ) -> anyhow::Result<SentJob> {
        self.send_as(&self.token(user), conversation, extra_metadata)
            .await
    }

    /// `user` queues a prompt to their `helper` agent in the log. The queue
    /// sends it at once only when the agent has no turn there.
    pub(crate) async fn queue(
        &self,
        user: Uuid,
        extra_metadata: JsonValue,
    ) -> anyhow::Result<Uuid> {
        let (status, entry) = self
            .call(
                "POST",
                format!("/conversations/{}/send-queue", self.space.log),
                Some(&self.token(user)),
                Some(json!({
                    "message": {
                        "promptText": "@helper look at the door",
                        "intent": "feature",
                        "metadata": prompt_metadata(extra_metadata),
                    },
                    "clientSendId": Uuid::new_v4().to_string(),
                })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "queue: {status} {entry}");
        Ok(Uuid::parse_str(entry["id"].as_str().unwrap_or_default())?)
    }

    /// The queue entry's status, when it was queued, and the run it started.
    pub(crate) async fn queue_entry(
        &self,
        entry: Uuid,
    ) -> anyhow::Result<(String, DateTime<Utc>, Option<Uuid>)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, created_at, dispatched_run_id
                   from conversation_send_queue where id = $1",
                &[&entry],
            )
            .await?;
        Ok((row.get(0), row.get(1), row.get(2)))
    }

    /// The run `entry` started, once a drain has sent it.
    pub(crate) async fn dispatched_run(&self, entry: Uuid) -> anyhow::Result<Uuid> {
        for _ in 0..100 {
            if let (_, _, Some(run)) = self.queue_entry(entry).await? {
                return Ok(run);
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        anyhow::bail!("queue entry {entry} started no run")
    }

    /// Ends every turn in the log, without the completion route's drain of
    /// the queue.
    pub(crate) async fn end_turns(&self) -> anyhow::Result<()> {
        sql(
            &self.pool,
            "update agent_jobs set status = 'completed', completed_at = now()
              where conversation_id = $1 and status in ('queued', 'leased')",
            &[&self.space.log],
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn db_now(&self) -> anyhow::Result<DateTime<Utc>> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one("select now()", &[])
            .await?
            .get(0))
    }

    /// `runtime`'s agent token in its current launch, which is ready.
    pub(crate) async fn agent_token(&self, runtime: Uuid) -> anyhow::Result<String> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "update runtimes set status = 'ready', last_seen_at = now() where id = $1
                 returning active_lease_id, capabilities",
                &[&runtime],
            )
            .await?;
        let lease_id: Option<Uuid> = row.get(0);
        let generation = crate::runtime::runtime_generation_from_capabilities(&row.get(1))
            .map_err(|(status, error)| anyhow::anyhow!("generation: {status} {}", error.message))?;
        let agent_token = crate::auth::issue_agent_token(
            &self.state.config,
            &self.space.project_id,
            &runtime,
            lease_id.as_ref(),
            generation,
        )
        .map_err(|(status, error)| anyhow::anyhow!("agent token: {status} {}", error.message))?
        .token;
        Ok(agent_token)
    }

    /// Leases the next job as `runtime`, running in its current launch.
    pub(crate) async fn lease(&self, runtime: Uuid) -> anyhow::Result<JsonValue> {
        let agent_token = self.agent_token(runtime).await?;
        let (status, body) = self
            .call(
                "POST",
                "/agent/lease",
                Some(&agent_token),
                Some(json!({ "max": 1, "lease_seconds": 120 })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "lease: {status} {body}");
        Ok(body["jobs"].get(0).cloned().unwrap_or(JsonValue::Null))
    }
}

pub(crate) fn prompt_metadata(extra: JsonValue) -> JsonValue {
    let mut metadata = json!({
        "clientMessageId": Uuid::new_v4().to_string(),
        "agentSelection": { "active": [], "mentions": ["helper"] },
    });
    if let Some(extra) = extra.as_object() {
        for (key, value) in extra {
            metadata[key] = value.clone();
        }
    }
    metadata
}

pub(crate) fn typed() -> JsonValue {
    json!({ "input": { "kind": "typed" } })
}

pub(crate) fn typed_with(extra: JsonValue) -> JsonValue {
    let mut metadata = typed();
    for (key, value) in extra.as_object().expect("object") {
        metadata[key] = value.clone();
    }
    metadata
}

pub(crate) struct SentJob {
    trigger: Trigger,
}

/// What started a job: its message's stamped kind, if its message has one,
/// and the job's person and receive time.
#[derive(Debug, PartialEq)]
struct Trigger {
    kind: Option<String>,
    stamped: bool,
    user_id: Option<Uuid>,
    received_at: Option<DateTime<Utc>>,
}

pub(crate) async fn job_of_run(pool: &PgPool, run_id: Uuid) -> anyhow::Result<SentJob> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select j.trigger_user_id, j.trigger_received_at, m.metadata ->> 'trigger' as kind,
                    coalesce(m.metadata ? 'trigger', false) as stamped
               from agent_jobs j
               left join lateral (
                 select metadata from conversation_messages
                  where run_id = j.run_id and role = 'user'
                  order by created_at limit 1
               ) m on true
              where j.run_id = $1",
            &[&run_id],
        )
        .await?;
    Ok(SentJob {
        trigger: Trigger {
            kind: row.get("kind"),
            stamped: row.get("stamped"),
            user_id: row.get("trigger_user_id"),
            received_at: row.get("trigger_received_at"),
        },
    })
}

pub(crate) async fn with_space<F, Fut>(label: &str, grants: bool, body: F) -> anyhow::Result<()>
where
    F: FnOnce(Harness) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let pool = require_origin_test_pool(label).await?;
    let space = Space::new();
    let users = vec![space.owner, space.member];
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let state = build_test_state(pool.clone(), config(label, &space, grants));
    let app = Router::new()
        .merge(crate::dispatch::router())
        .merge(crate::conversations::router())
        .merge(crate::send_queue::router())
        .merge(crate::send_intents::router())
        .merge(crate::agent::router())
        .merge(crate::automations::router())
        .with_state(state.clone());
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async move {
        space.seed(&body_pool, label).await?;
        body(Harness {
            pool: body_pool,
            state,
            app,
            space,
        })
        .await
    })
    .await;
    let cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = any($1)", &[&users])
        .await;
    result.and(cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

pub(crate) fn normalized(
    space: &Space,
    conversation: Uuid,
) -> anyhow::Result<DispatchPromptNormalized> {
    dispatch::normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(space.project_id.to_string()),
        session_id: None,
        prompt_text: Some("@helper look at the door".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(prompt_metadata(typed())),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(conversation.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|(status, error)| anyhow::anyhow!("normalize: {status} {}", error.message))
}

pub(crate) async fn dispatch_directly(
    harness: &Harness,
    context: RequestContext,
    request: DispatchPromptNormalized,
) -> anyhow::Result<SentJob> {
    let response = dispatch::process_dispatch_prompt(&harness.state, &context, request)
        .await
        .map_err(|(status, error)| anyhow::anyhow!("dispatch: {status} {}", error.message))?;
    let run_id = response
        .run_id
        .ok_or_else(|| anyhow::anyhow!("dispatch started no run"))?;
    job_of_run(&harness.pool, run_id).await
}

pub(crate) fn user(user_id: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(user_id),
        is_service_role: false,
        scoped_claims: None,
    }
}

fn kind_and_user(trigger: &Trigger) -> (Option<&str>, Option<Uuid>) {
    (trigger.kind.as_deref(), trigger.user_id)
}

/// Only the message route, from the caller's own credential, says a person
/// typed a job's prompt, and when the controller received it. Nothing a
/// client writes makes a job's own message or an unmarked send a person's.
/// Every other kind is `job_trigger.rs`'s table.
#[tokio::test]
async fn a_job_records_what_started_it() -> anyhow::Result<()> {
    with_space("job-trigger", true, |harness| async move {
        let space = &harness.space;

        let before = harness.db_now().await?;
        let job = harness.send(space.owner, space.log, typed()).await?;
        let after = harness.db_now().await?;
        assert_eq!(
            kind_and_user(&job.trigger),
            (Some("person"), Some(space.owner))
        );
        let received_at = job.trigger.received_at.expect("received");
        assert!(
            before <= received_at && received_at <= after,
            "{before} <= {received_at} <= {after}"
        );

        // Whoever sends it: another member's typed send is theirs.
        let job = harness.send(space.member, space.log, typed()).await?;
        assert_eq!(
            kind_and_user(&job.trigger),
            (Some("person"), Some(space.member))
        );

        // Speech one of the owner's devices heard.
        let job = harness
            .send(
                space.owner,
                space.log,
                json!({ "input": { "kind": "voice", "deviceId": DEVICE_ID } }),
            )
            .await?;
        assert_eq!(
            kind_and_user(&job.trigger),
            (Some("device_voice"), Some(space.owner))
        );

        // A send whose client says nothing of how it was made, or writes a
        // trigger of its own, has none.
        for extra in [
            json!({}),
            json!({ "trigger": { "kind": "person" }, "triggerKind": "person" }),
        ] {
            let job = harness.send(space.owner, space.log, extra.clone()).await?;
            assert_eq!(job.trigger.kind, None, "{extra}");
            assert!(job.trigger.stamped, "{extra}");
            assert_eq!(job.trigger.received_at, None, "{extra}");
        }

        // A job's own message is automatic, though its token acts there as
        // the person the job is for.
        let leased = harness.lease(space.runtime).await?;
        let job_token = leased["controller_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("no job token: {leased}"))?
            .to_string();
        let subject = Uuid::parse_str(leased["payload"]["user_id"].as_str().unwrap_or_default())?;
        let job = harness.send_as(&job_token, space.log, typed()).await?;
        assert_eq!(
            kind_and_user(&job.trigger),
            (Some("automatic"), Some(subject))
        );

        // The routes that start a conversation with a prompt, or dispatch one,
        // say the same.
        let owner = harness.token(space.owner);
        let (status, started) = harness
            .call(
                "POST",
                format!("/projects/{}/conversations", space.project_id),
                Some(&owner),
                Some(json!({
                    "promptText": "@helper look at the door",
                    "intent": "feature",
                    "metadata": prompt_metadata(typed()),
                })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "start: {status} {started}");
        let (status, dispatched) = harness
            .call(
                "POST",
                "/dispatch-prompt",
                Some(&owner),
                Some(json!({
                    "projectId": space.project_id,
                    "conversationId": space.log,
                    "promptText": "@helper look at the door",
                    "intent": "feature",
                    "metadata": prompt_metadata(json!({ "input": { "kind": "voice", "deviceId": DEVICE_ID } })),
                })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "dispatch: {status} {dispatched}");
        for (response, kind) in [(started, "person"), (dispatched, "device_voice")] {
            let job = job_of_run(
                &harness.pool,
                Uuid::parse_str(response["runId"].as_str().unwrap_or_default())?,
            )
            .await?;
            assert_eq!(kind_and_user(&job.trigger), (Some(kind), Some(space.owner)));
        }

        // A message recorded without a turn says what made it too, whatever
        // its client wrote there.
        for (metadata, stamp) in [
            (typed(), json!("person")),
            (json!({ "trigger": "person" }), JsonValue::Null),
        ] {
            let (status, recorded) = harness
                .call(
                    "POST",
                    format!("/conversations/{}/messages/record", space.log),
                    Some(&owner),
                    Some(json!({ "content": "noted", "metadata": metadata })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{recorded}");
            assert_eq!(recorded["metadata"]["trigger"], stamp, "{recorded}");
        }

        // A dispatch no route stamped has none.
        let job =
            dispatch_directly(&harness, user(space.owner), normalized(space, space.log)?).await?;
        assert_eq!(
            job.trigger,
            Trigger {
                kind: None,
                stamped: true,
                user_id: None,
                received_at: None,
            }
        );

        // An automation runs as its owner, whoever presses Run now.
        let (status, automation) = harness
            .call(
                "POST",
                format!("/projects/{}/automations", space.project_id),
                Some(&owner),
                Some(json!({
                    "name": "Door check",
                    "promptText": "@helper look at the door",
                    "metadata": prompt_metadata(typed()),
                    "scheduleKind": "hourly",
                    "intervalHours": 24,
                    "timezone": "UTC",
                    "runtimeMode": "existing",
                })),
            )
            .await?;
        anyhow::ensure!(
            status == StatusCode::OK,
            "automation: {status} {automation}"
        );
        let (status, run) = harness
            .call(
                "POST",
                format!(
                    "/automations/{}/run",
                    automation["id"].as_str().unwrap_or_default()
                ),
                Some(&owner),
                None,
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "run now: {status} {run}");
        // Run now starts it in the background.
        let conversation = Uuid::parse_str(automation["conversationId"].as_str().unwrap_or_default())?;
        let mut trigger = None;
        for _ in 0..100 {
            let row = harness
                .pool
                .get()
                .await?
                .query_opt(
                    "select m.metadata ->> 'trigger', j.trigger_user_id
                       from agent_jobs j
                       join conversation_messages m on m.run_id = j.run_id and m.role = 'user'
                      where j.conversation_id = $1",
                    &[&conversation],
                )
                .await?;
            if let Some(row) = row {
                trigger = Some((row.get::<_, Option<String>>(0), row.get::<_, Option<Uuid>>(1)));
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let (kind, user_id) = trigger.ok_or_else(|| anyhow::anyhow!("the automation started no job"))?;
        assert_eq!(
            (kind.as_deref(), user_id),
            (Some("automatic"), Some(space.owner))
        );
        Ok(())
    })
    .await
}

/// The queue takes a message from its person's own session, so the drain
/// sends it as theirs, received when it was queued. Send now, which the person
/// presses, sends it as received then.
#[tokio::test]
async fn a_queued_message_is_received_when_queued_or_when_its_person_sends_it_now(
) -> anyhow::Result<()> {
    with_space("job-trigger-queue", true, |harness| async move {
        let space = &harness.space;
        // The owner's agent has a turn in the log, so what they queue waits,
        // once the drain each queueing starts has found it busy.
        let settle = || tokio::time::sleep(std::time::Duration::from_millis(300));
        harness.send(space.owner, space.log, typed()).await?;
        let waiting = harness.queue(space.owner, typed()).await?;
        let resend = harness
            .queue(
                space.owner,
                typed_with(json!({ "retryOfMessageId": Uuid::new_v4().to_string() })),
            )
            .await?;
        settle().await;
        let (status, queued_at, _) = harness.queue_entry(waiting).await?;
        assert_eq!(status, "queued");

        // The drain sends it once that turn is over.
        harness.end_turns().await?;
        crate::send_queue::recover_send_queue_batch(&harness.state, None)
            .await
            .map_err(|(status, error)| anyhow::anyhow!("drain: {status} {}", error.message))?;
        let job = job_of_run(&harness.pool, harness.dispatched_run(waiting).await?).await?;
        assert_eq!(
            job.trigger,
            Trigger {
                kind: Some("person".to_string()),
                stamped: true,
                user_id: Some(space.owner),
                received_at: Some(queued_at),
            }
        );

        // A queued resend is still a resend.
        harness.end_turns().await?;
        crate::send_queue::recover_send_queue_batch(&harness.state, None)
            .await
            .map_err(|(status, error)| anyhow::anyhow!("drain: {status} {}", error.message))?;
        let job = job_of_run(&harness.pool, harness.dispatched_run(resend).await?).await?;
        assert_eq!(
            kind_and_user(&job.trigger),
            (Some("resend"), Some(space.owner))
        );

        // Send now, pressed later, is received when pressed.
        let pressed = harness.queue(space.owner, typed()).await?;
        settle().await;
        let (_, queued_at, _) = harness.queue_entry(pressed).await?;
        harness.end_turns().await?;
        let before = harness.db_now().await?;
        let (status, body) = harness
            .call(
                "POST",
                format!("/conversations/{}/send-queue/{pressed}/dispatch", space.log),
                Some(&harness.token(space.owner)),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let job = job_of_run(
            &harness.pool,
            Uuid::parse_str(body["runId"].as_str().unwrap_or_default())?,
        )
        .await?;
        assert_eq!(
            kind_and_user(&job.trigger),
            (Some("person"), Some(space.owner))
        );
        let received_at = job.trigger.received_at.expect("received");
        assert!(
            received_at >= before && received_at > queued_at,
            "{queued_at} < {before} <= {received_at}"
        );
        Ok(())
    })
    .await
}

/// With device grants off, a job still records whose cause it was and when,
/// but no message gains a trigger key, and a client's is dropped from the
/// messages a client writes.
#[tokio::test]
async fn without_the_flag_no_message_says_what_made_it() -> anyhow::Result<()> {
    with_space("job-trigger-flag-off", false, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);

        let job = harness.send(space.owner, space.log, typed()).await?;
        assert_eq!(job.trigger.user_id, Some(space.owner));
        assert!(job.trigger.received_at.is_some());
        assert!(!job.trigger.stamped);
        let job = harness
            .send(space.owner, space.log, json!({ "trigger": "person" }))
            .await?;
        assert!(!job.trigger.stamped);

        let (status, recorded) = harness
            .call(
                "POST",
                format!("/conversations/{}/messages/record", space.log),
                Some(&owner),
                Some(json!({ "content": "noted", "metadata": { "trigger": "person" } })),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{recorded}");
        assert!(recorded["metadata"].get("trigger").is_none(), "{recorded}");

        let stamped: i64 = harness
            .pool
            .get()
            .await?
            .query_one(
                "select count(*) from conversation_messages
                  where conversation_id = $1 and metadata ? 'trigger'",
                &[&space.log],
            )
            .await?
            .get(0);
        assert_eq!(stamped, 0);
        Ok(())
    })
    .await
}
