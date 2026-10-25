#![cfg(test)]

// What started an agent job and how it may be delivered, and a provider
// device's owner, on the migrated database: the message routes, the send queue
// and automations record a job's trigger from the caller's own credential, a
// message says what made it only where device grants are on for its sender,
// the lease, a runtime stop and the idle sweep honour a job's delivery
// options, and an owned device answers only to its owner. Requires
// `TEST_DATABASE_URL` like the tests in `tests.rs`.

use axum::http::StatusCode;
use axum::Router;
use chrono::{DateTime, Utc};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::agent::JobDelivery;
use crate::auth::RequestContext;
use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::dispatch::{self, DispatchPromptNormalized, DispatchPromptRequest};
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, require_origin_test_pool,
    sql, test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::AppState;

pub(crate) const PROVIDER_ID: &str = "device:delivery-test";
pub(crate) const DEVICE_ID: &str = "device-1";
pub(crate) const OTHER_DEVICE_ID: &str = "device-2";

/// An org whose space has an owner and another member, each with an agent
/// called `helper`, and two self-hosted machines of the owner's.
pub(crate) struct Space {
    pub(crate) org_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) owner: Uuid,
    pub(crate) member: Uuid,
    /// A conversation everyone in the space reads.
    pub(crate) log: Uuid,
    pub(crate) runtime: Uuid,
    pub(crate) other_machine: Uuid,
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
            other_machine: Uuid::new_v4(),
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
                "insert into project_integrations (id, project_id, provider, status, connection_type)
                 values ($1, $2, $3, 'attached', 'device')",
                &[&Uuid::new_v4(), &self.project_id, &PROVIDER_ID],
            )
            .await?;
        for runtime in [self.runtime, self.other_machine] {
            connection
                .execute(
                    "insert into runtimes (
                         id, project_id, provider, status, idle_ttl_seconds, last_seen_at,
                         capabilities
                     ) values ($1, $2, 'self-hosted', 'ready', 600, now(), $3)",
                    &[&runtime, &self.project_id, &PgJson(capabilities.clone())],
                )
                .await?;
        }
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
    pub(crate) id: Uuid,
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
            "select j.id, j.trigger_user_id, j.trigger_received_at,
                    m.metadata ->> 'trigger' as kind,
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
        id: row.get("id"),
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
        .merge(crate::provider_requests::router())
        .merge(crate::provider_devices::router())
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
/// messages a client writes. Nobody takes a device or publishes its catalog,
/// and no device has an owner to answer to: one owned from when grants were
/// on keeps the project's rules.
#[tokio::test]
async fn without_the_flag_no_message_says_what_made_it_and_no_device_has_an_owner(
) -> anyhow::Result<()> {
    with_space("grants-flag-off", false, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);
        let member = harness.token(space.member);

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

        let (status, body) = harness.heartbeat(&member, DEVICE_ID, json!({})).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = harness
            .heartbeat(
                &owner,
                DEVICE_ID,
                json!({ "owned": true, "catalog": catalog(&["device.look"]) }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(harness.device(DEVICE_ID).await?, (None, None));
        // A heartbeat answers as before, with no owner or catalog in it.
        for key in ["ownerUserId", "catalog", "catalogHash", "owned"] {
            assert!(body.get(key).is_none(), "{key}: {body}");
        }

        harness.own_device(catalog(&["device.look"])).await?;
        let (status, _) = harness.heartbeat(&member, DEVICE_ID, json!({})).await?;
        assert_eq!(status, StatusCode::OK);
        let members = harness.request(space.member, None, None).await?;
        let (status, listed) = harness.listed(&member, Some(DEVICE_ID)).await?;
        assert_eq!((status, listed), (StatusCode::OK, vec![members]));
        assert_eq!(
            harness.act(&member, members, "claim", DEVICE_ID).await?,
            StatusCode::OK
        );
        assert_eq!(
            harness.device(DEVICE_ID).await?.0,
            Some(space.owner),
            "nothing changed its owner"
        );
        Ok(())
    })
    .await
}

/// The job's delivery columns, its target runtime, status and error.
pub(crate) async fn delivery_row(
    harness: &Harness,
    job: Uuid,
) -> anyhow::Result<tokio_postgres::Row> {
    Ok(harness
        .pool
        .get()
        .await?
        .query_one(
            "select status, target_runtime_id, at_most_once, start_by, strict_pin,
                    error_message, now() as now
               from agent_jobs where id = $1",
            &[&job],
        )
        .await?)
}

/// A request of `job` that `DEVICE_ID` has claimed.
async fn claimed_request_of(harness: &Harness, job: Uuid) -> anyhow::Result<Uuid> {
    let request = Uuid::new_v4();
    sql(
        &harness.pool,
        "insert into project_provider_requests (
             id, project_id, provider_id, request_kind, tool_name, arguments, status,
             requested_by, job_id, claimed_by_device_id, claimed_at, expires_at
         ) values ($1, $2, $3, 'tool_call', 'device.move', '{}'::jsonb, 'claimed',
             $4, $5, $6, now(), now() + interval '30 seconds')",
        &[
            &request,
            &harness.space.project_id,
            &PROVIDER_ID,
            &harness.space.owner,
            &job,
            &DEVICE_ID,
        ],
    )
    .await?;
    Ok(request)
}

/// Stops `runtime` as its runtime stop would, then brings it back, and gives
/// the jobs the stop requeued.
async fn stop_runtime(harness: &Harness, runtime: Uuid) -> anyhow::Result<Vec<Uuid>> {
    let mut connection = harness.pool.get().await?;
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
    Ok(outcome.requeued_jobs)
}

/// A job queued with delivery options is leased only as they allow: at most
/// once, only by its deadline, and only by the runtime it is pinned to, which
/// it keeps through a runtime stop and an unready runtime's alert. Its lease
/// tells its runtime that it runs once. The idle sweep fails what can no
/// longer start, and cancels its open device requests. A job without options
/// is delivered as before.
#[tokio::test]
async fn a_job_is_delivered_only_as_its_options_allow() -> anyhow::Result<()> {
    with_space("job-delivery", false, |harness| async move {
        let space = &harness.space;
        let strict = JobDelivery {
            at_most_once: true,
            start_within_s: Some(60),
            strict_pin: true,
        };
        let on_machine = |delivery: JobDelivery| -> anyhow::Result<DispatchPromptNormalized> {
            let mut request = normalized(space, space.log)?;
            request.runtime_id = Some(space.runtime);
            request.prefer_runtime = true;
            request.delivery = delivery;
            Ok(request)
        };

        let job = dispatch_directly(&harness, user(space.owner), on_machine(strict)?).await?;
        let row = delivery_row(&harness, job.id).await?;
        assert_eq!(
            row.get::<_, Option<Uuid>>("target_runtime_id"),
            Some(space.runtime)
        );
        assert!(row.get::<_, bool>("at_most_once") && row.get::<_, bool>("strict_pin"));
        let start_by: DateTime<Utc> = row
            .get::<_, Option<DateTime<Utc>>>("start_by")
            .expect("start_by");
        let now: DateTime<Utc> = row.get("now");
        assert!(
            (start_by - now - chrono::Duration::seconds(60))
                .num_seconds()
                .abs()
                <= 5,
            "{now} + 60 s ~ {start_by}"
        );

        // Not even a spread job's rule lets another runtime take it.
        sql(
            &harness.pool,
            "update agent_jobs
                set payload = jsonb_set(payload, '{metadata,runtimeRouting}',
                                        '{\"strategy\": \"spread\"}')
              where id = $1",
            &[&job.id],
        )
        .await?;
        assert_eq!(harness.lease(space.other_machine).await?, JsonValue::Null);
        let leased = harness.lease(space.runtime).await?;
        assert_eq!(leased["id"], json!(job.id));
        // The runtime gets only what it acts on; the controller enforces the
        // deadline and the pin itself.
        assert_eq!(leased["payload"]["delivery"], json!({ "atMostOnce": true }));

        // Its runtime stops while it runs, holding a device's call: it is
        // requeued still pinned, but never leased again. The sweep fails it
        // and cancels the call.
        let request = claimed_request_of(&harness, job.id).await?;
        assert_eq!(stop_runtime(&harness, space.runtime).await?, vec![job.id]);
        let row = delivery_row(&harness, job.id).await?;
        assert_eq!(row.get::<_, String>("status"), "queued");
        assert_eq!(
            row.get::<_, Option<Uuid>>("target_runtime_id"),
            Some(space.runtime)
        );
        assert_eq!(harness.lease(space.runtime).await?, JsonValue::Null);
        crate::runtime::sweep_idle_activity(&harness.state).await?;
        let row = delivery_row(&harness, job.id).await?;
        assert_eq!(row.get::<_, String>("status"), "failed");
        assert!(
            row.get::<_, Option<String>>("error_message")
                .is_some_and(|error| error.contains("may run only once")),
            "{:?}",
            row.get::<_, Option<String>>("error_message")
        );
        let canceled = harness
            .pool
            .get()
            .await?
            .query_one(
                "select status, cancel_reason from project_provider_requests where id = $1",
                &[&request],
            )
            .await?;
        assert_eq!(
            (
                canceled.get::<_, String>(0),
                canceled.get::<_, Option<String>>(1)
            ),
            ("canceled".to_string(), None)
        );

        // A job past its deadline is never leased, and the sweep fails it.
        let late = dispatch_directly(&harness, user(space.owner), on_machine(strict)?).await?;
        sql(
            &harness.pool,
            "update agent_jobs set start_by = now() - interval '1 second' where id = $1",
            &[&late.id],
        )
        .await?;
        assert_eq!(harness.lease(space.runtime).await?, JsonValue::Null);
        crate::runtime::sweep_idle_activity(&harness.state).await?;
        let row = delivery_row(&harness, late.id).await?;
        assert_eq!(row.get::<_, String>("status"), "failed");
        assert!(row
            .get::<_, Option<String>>("error_message")
            .is_some_and(|error| error.contains("start by a set time")));

        // Dispatched while its runtime is not ready, a strictly pinned job
        // stays pinned where any other is unpinned for another runtime.
        sql(
            &harness.pool,
            "update runtimes set last_seen_at = now() - interval '1 hour' where id = $1",
            &[&space.runtime],
        )
        .await?;
        for (delivery, target) in [
            (strict, Some(space.runtime)),
            (JobDelivery::default(), None),
        ] {
            let job = dispatch_directly(&harness, user(space.owner), on_machine(delivery)?).await?;
            let row = delivery_row(&harness, job.id).await?;
            assert_eq!(
                row.get::<_, Option<Uuid>>("target_runtime_id"),
                target,
                "{delivery:?}"
            );
        }

        // A deadline and a pin are the controller's alone: a job with only
        // those leases with no delivery for its runtime.
        sql(
            &harness.pool,
            "update runtimes set last_seen_at = now() where id = $1",
            &[&space.runtime],
        )
        .await?;
        harness.end_turns().await?;
        let pinned = JobDelivery {
            start_within_s: Some(60),
            strict_pin: true,
            ..JobDelivery::default()
        };
        let pinned = dispatch_directly(&harness, user(space.owner), on_machine(pinned)?).await?;
        let leased = harness.lease(space.runtime).await?;
        assert_eq!(leased["id"], json!(pinned.id));
        assert!(leased["payload"].get("delivery").is_none(), "{leased}");

        // Without options a job is leased as before: a stop unpins it, and
        // its lease carries no delivery.
        harness.end_turns().await?;
        let plain = dispatch_directly(
            &harness,
            user(space.owner),
            on_machine(JobDelivery::default())?,
        )
        .await?;
        let leased = harness.lease(space.runtime).await?;
        assert_eq!(leased["id"], json!(plain.id));
        assert!(leased["payload"].get("delivery").is_none(), "{leased}");
        assert_eq!(stop_runtime(&harness, space.runtime).await?, vec![plain.id]);
        let row = delivery_row(&harness, plain.id).await?;
        assert_eq!(row.get::<_, Option<Uuid>>("target_runtime_id"), None);
        Ok(())
    })
    .await
}

/// A catalog in MCP tools/list shape with `names`.
pub(crate) fn catalog(names: &[&str]) -> JsonValue {
    json!({
        "instructions": "Use the device only when asked to.",
        "tools": names
            .iter()
            .map(|name| json!({
                "name": name,
                "description": format!("Does {name}."),
                "inputSchema": { "type": "object", "properties": {} },
            }))
            .collect::<Vec<_>>(),
    })
}

impl Harness {
    pub(crate) async fn heartbeat(
        &self,
        token: &str,
        device_id: &str,
        extra: JsonValue,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let mut body = json!({ "providerId": PROVIDER_ID, "deviceId": device_id });
        for (key, value) in extra.as_object().expect("object") {
            body[key] = value.clone();
        }
        self.call(
            "POST",
            format!(
                "/projects/{}/provider-devices/heartbeat",
                self.space.project_id
            ),
            Some(token),
            Some(body),
        )
        .await
    }

    /// The device's stored owner and catalog.
    async fn device(&self, device_id: &str) -> anyhow::Result<(Option<Uuid>, Option<JsonValue>)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select owner_user_id, catalog from project_provider_devices
                  where project_id = $1 and provider_id = $2 and device_id = $3",
                &[&self.space.project_id, &PROVIDER_ID, &device_id],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    /// Makes `DEVICE_ID` the space owner's, with `catalog`, as when device
    /// grants were on for them.
    pub(crate) async fn own_device(&self, catalog: JsonValue) -> anyhow::Result<()> {
        sql(
            &self.pool,
            "update project_provider_devices set owner_user_id = $3, catalog = $4
              where project_id = $1 and provider_id = $2 and device_id = $5",
            &[
                &self.space.project_id,
                &PROVIDER_ID,
                &self.space.owner,
                &catalog,
                &DEVICE_ID,
            ],
        )
        .await?;
        Ok(())
    }

    /// A pending request `requested_by` made, for `target` or any device,
    /// and for `job` if a job made it.
    pub(crate) async fn request(
        &self,
        requested_by: Uuid,
        target: Option<&str>,
        job: Option<Uuid>,
    ) -> anyhow::Result<Uuid> {
        let request = Uuid::new_v4();
        sql(
            &self.pool,
            "insert into project_provider_requests (
                 id, project_id, provider_id, request_kind, tool_name, arguments, status,
                 requested_by, target_device_id, job_id, expires_at
             ) values ($1, $2, $3, 'tool_call', 'device.move', '{}'::jsonb, 'pending',
                 $4, $5, $6, now() + interval '30 seconds')",
            &[
                &request,
                &self.space.project_id,
                &PROVIDER_ID,
                &requested_by,
                &target,
                &job,
            ],
        )
        .await?;
        Ok(request)
    }

    /// The pending requests `token`'s holder lists, as `device_id` if given.
    async fn listed(
        &self,
        token: &str,
        device_id: Option<&str>,
    ) -> anyhow::Result<(StatusCode, Vec<Uuid>)> {
        let device = device_id
            .map(|device| format!("&deviceId={device}"))
            .unwrap_or_default();
        let (status, body) = self
            .call(
                "GET",
                format!(
                    "/projects/{}/provider-requests?providerId={PROVIDER_ID}&limit=20{device}",
                    self.space.project_id
                ),
                Some(token),
                None,
            )
            .await?;
        let ids = body
            .as_array()
            .map(|requests| {
                requests
                    .iter()
                    .filter_map(|request| request["id"].as_str())
                    .filter_map(|id| Uuid::parse_str(id).ok())
                    .collect()
            })
            .unwrap_or_default();
        Ok((status, ids))
    }

    pub(crate) async fn act(
        &self,
        token: &str,
        request: Uuid,
        action: &str,
        device_id: &str,
    ) -> anyhow::Result<StatusCode> {
        let body = match action {
            "complete" => json!({
                "providerId": PROVIDER_ID,
                "deviceId": device_id,
                "response": { "ok": true },
            }),
            _ => json!({ "providerId": PROVIDER_ID, "deviceId": device_id }),
        };
        let path = format!(
            "/projects/{}/provider-requests/{request}/{action}",
            self.space.project_id,
        );
        let (status, _) = self.call("POST", path, Some(token), Some(body)).await?;
        Ok(status)
    }
}

/// A device its owner registered from their own session is theirs alone: only
/// they heartbeat it, write its catalog, list its requests, and claim and
/// complete requests as it, and it takes only their requests. A device without
/// an owner keeps the project's rules.
#[tokio::test]
async fn an_owned_device_answers_only_to_its_owner() -> anyhow::Result<()> {
    with_space("device-owner", true, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);
        let member = harness.token(space.member);

        // The owner registers the device with its catalog.
        let looks = catalog(&["device.look", "device.move"]);
        let (status, device) = harness
            .heartbeat(
                &owner,
                DEVICE_ID,
                json!({ "owned": true, "catalog": looks }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{device}");
        assert_eq!(
            harness.device(DEVICE_ID).await?,
            (Some(space.owner), Some(looks.clone()))
        );

        // Nobody else heartbeats it, takes it or rewrites its catalog.
        for extra in [
            json!({}),
            json!({ "owned": true }),
            json!({ "catalog": catalog(&["device.erase"]) }),
        ] {
            let (status, body) = harness.heartbeat(&member, DEVICE_ID, extra.clone()).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{extra}: {body}");
        }
        // A heartbeat without a catalog keeps it; a new one replaces it.
        harness.heartbeat(&owner, DEVICE_ID, json!({})).await?;
        assert_eq!(
            harness.device(DEVICE_ID).await?,
            (Some(space.owner), Some(looks))
        );
        let look = catalog(&["device.look"]);
        harness
            .heartbeat(&owner, DEVICE_ID, json!({ "catalog": look }))
            .await?;
        assert_eq!(harness.device(DEVICE_ID).await?.1, Some(look));
        // A catalog must have the MCP shape and fit its limits
        // (provider_devices.rs).
        let (status, body) = harness
            .heartbeat(
                &owner,
                DEVICE_ID,
                json!({ "catalog": { "tools": [{ "name": "device look" }] } }),
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        let owners_own = harness.request(space.owner, Some(DEVICE_ID), None).await?;
        let owners_any = harness.request(space.owner, None, None).await?;
        let members_any = harness.request(space.member, None, None).await?;
        // A request of a running job of the owner's.
        let running = harness.send(space.owner, space.log, typed()).await?;
        sql(
            &harness.pool,
            "update agent_jobs set status = 'leased' where id = $1",
            &[&running.id],
        )
        .await?;
        let owners_job = harness.request(space.owner, None, Some(running.id)).await?;

        // The owned device lists only for its owner, and only their requests.
        let (status, _) = harness.listed(&member, Some(DEVICE_ID)).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, listed) = harness.listed(&owner, Some(DEVICE_ID)).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed, vec![owners_own, owners_any, owners_job]);
        let (_, listed) = harness.listed(&member, Some(OTHER_DEVICE_ID)).await?;
        assert_eq!(listed, vec![owners_any, members_any]);

        // Nobody else acts as the owned device, even on the owner's own
        // request, and it acts on nobody else's request.
        for request in [owners_own, owners_any, members_any] {
            for action in ["claim", "complete"] {
                assert_eq!(
                    harness.act(&member, request, action, DEVICE_ID).await?,
                    StatusCode::FORBIDDEN,
                    "{action} {request}"
                );
            }
        }
        assert_eq!(
            harness.act(&owner, members_any, "claim", DEVICE_ID).await?,
            StatusCode::FORBIDDEN
        );
        // A device without an owner keeps the project's rules.
        assert_eq!(
            harness
                .act(&member, owners_any, "claim", OTHER_DEVICE_ID)
                .await?,
            StatusCode::OK
        );

        // The owner claims and completes their request as the device.
        assert_eq!(
            harness.act(&owner, owners_own, "claim", DEVICE_ID).await?,
            StatusCode::OK
        );
        assert_eq!(
            harness
                .act(&member, owners_own, "complete", DEVICE_ID)
                .await?,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            harness
                .act(&owner, owners_own, "complete", DEVICE_ID)
                .await?,
            StatusCode::OK
        );
        Ok(())
    })
    .await
}

/// A device whose owner may no longer write to its space, because they lost
/// write access or left the space, is nobody's: the space's other people use
/// it under the space's rules, and may take it.
#[tokio::test]
async fn a_device_whose_owner_lost_the_space_is_nobodys() -> anyhow::Result<()> {
    with_space("device-owner-left", true, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);
        let member = harness.token(space.member);
        for device in [DEVICE_ID, OTHER_DEVICE_ID] {
            let (status, body) = harness
                .heartbeat(&member, device, json!({ "owned": true }))
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let (status, _) = harness.heartbeat(&owner, device, json!({})).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{device}");
        }

        for (device, project_change, team_change) in [
            (
                DEVICE_ID,
                "update project_memberships set role = 'viewer'
                  where project_id = $1 and user_id = $2",
                "update org_memberships set role = 'viewer' where org_id = $1 and user_id = $2",
            ),
            (
                OTHER_DEVICE_ID,
                "delete from project_memberships where project_id = $1 and user_id = $2",
                "delete from org_memberships where org_id = $1 and user_id = $2",
            ),
        ] {
            let connection = harness.pool.get().await?;
            connection
                .execute(project_change, &[&space.project_id, &space.member])
                .await?;
            connection
                .execute(team_change, &[&space.org_id, &space.member])
                .await?;
            drop(connection);
            // Its stored owner can no longer heartbeat it, and nobody else is
            // told it is theirs.
            let (status, _) = harness.heartbeat(&member, device, json!({})).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{device}");
            let (status, body) = harness.heartbeat(&owner, device, json!({})).await?;
            assert_eq!(status, StatusCode::OK, "{device}: {body}");
            let request = harness.request(space.owner, Some(device), None).await?;
            let (status, listed) = harness.listed(&owner, Some(device)).await?;
            assert_eq!(
                (status, listed),
                (StatusCode::OK, vec![request]),
                "{device}"
            );
            assert_eq!(
                harness.act(&owner, request, "claim", device).await?,
                StatusCode::OK,
                "{device}"
            );
            // And the space's owner may take it.
            let (status, _) = harness
                .heartbeat(&owner, device, json!({ "owned": true }))
                .await?;
            assert_eq!(status, StatusCode::OK, "{device}");
            assert_eq!(
                harness.device(device).await?.0,
                Some(space.owner),
                "{device}"
            );
        }
        Ok(())
    })
    .await
}
