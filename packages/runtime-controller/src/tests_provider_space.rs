#![cfg(test)]

// The space the provider request, job trigger and device grant tests share: an
// org whose space has an owner, a member and a guest, a device provider
// attached, and a harness that calls the controller's routes as them, plus
// the provider request rows they insert and read back. Requires
// `TEST_DATABASE_URL` like the tests in `tests.rs`.

use axum::http::StatusCode;
use axum::Router;
use chrono::{DateTime, Utc};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::config::{AppConfig, DeviceGrantUsers, PgPool, RuntimeProviderConfig};
use crate::dispatch::{self, DispatchPromptNormalized, DispatchPromptRequest};
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, eventually,
    require_origin_test_pool, sql, sql_one, test_origin_private_key, test_origin_public_key,
    with_shared_db_fixture, SharedDbFixture,
};
use crate::AppState;

pub(crate) const PROVIDER_ID: &str = "device:provider-test";
pub(crate) const DEVICE_ID: &str = "device-1";
pub(crate) const OTHER_DEVICE_ID: &str = "device-2";
pub(crate) const SERVICE_ROLE: &str = "service-role-token";

/// A provider request as a dispatch would have left it. Offsets are seconds
/// from now; a claimed request was claimed when it was created.
pub(crate) struct NewRequest<'a> {
    pub(crate) status: &'a str,
    pub(crate) requested_by: Option<Uuid>,
    pub(crate) target: Option<&'a str>,
    pub(crate) job: Option<Uuid>,
    pub(crate) claimed_by: Option<&'a str>,
    pub(crate) created_in: i64,
    pub(crate) expires_in: i64,
    pub(crate) error: Option<&'a str>,
}

impl Default for NewRequest<'_> {
    fn default() -> Self {
        Self {
            status: "pending",
            requested_by: None,
            target: None,
            job: None,
            claimed_by: None,
            created_in: 0,
            expires_in: 30,
            error: None,
        }
    }
}

/// Inserts `request` into `project`, and gives its id.
pub(crate) async fn insert_request(
    pool: &PgPool,
    project: Uuid,
    request: NewRequest<'_>,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    sql(
        pool,
        "insert into project_provider_requests (
             id, project_id, provider_id, request_kind, tool_name, arguments, status,
             requested_by, target_device_id, job_id, claimed_by_device_id, claimed_at, error,
             created_at, updated_at, expires_at
         ) values (
             $1, $2, $3, 'tool_call', 'device.move', '{}'::jsonb, $4, $5, $6, $7, $8::text,
             case when $8::text is null then null else now() + $9::bigint * interval '1 second' end,
             $10, now() + $9::bigint * interval '1 second', now(),
             now() + $11::bigint * interval '1 second'
         )",
        &[
            &id,
            &project,
            &PROVIDER_ID,
            &request.status,
            &request.requested_by,
            &request.target,
            &request.job,
            &request.claimed_by,
            &request.created_in,
            &request.error,
            &request.expires_in,
        ],
    )
    .await?;
    Ok(id)
}

/// A provider request as a test reads it back.
#[derive(Debug, PartialEq)]
pub(crate) struct Requested {
    pub(crate) id: Uuid,
    pub(crate) status: String,
    pub(crate) cancel_reason: Option<String>,
    pub(crate) error: Option<String>,
}

/// `id` as its cancel leaves it: with `reason` `steered` by a steer, with no
/// reason by any other end of its job.
pub(crate) fn canceled(id: Uuid, reason: Option<&str>) -> Requested {
    let error = match reason {
        Some("steered") => "The provider request was canceled because its turn was steered.",
        _ => "The provider request was canceled.",
    };
    Requested {
        id,
        status: "canceled".to_string(),
        cancel_reason: reason.map(str::to_string),
        error: Some(error.to_string()),
    }
}

/// The ids of a listing of provider requests.
pub(crate) fn listed_ids(listing: &JsonValue) -> Vec<Uuid> {
    listing
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["id"].as_str())
                .filter_map(|id| Uuid::parse_str(id).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// An org whose space has an owner, another member and a guest, each with an
/// agent called `helper`, two conversations the owner started, and two
/// self-hosted machines of the owner's.
pub(crate) struct Space {
    pub(crate) org_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) owner: Uuid,
    pub(crate) member: Uuid,
    /// A member of the space only, not of its org.
    pub(crate) guest: Uuid,
    pub(crate) owner_agent: Uuid,
    pub(crate) member_agent: Uuid,
    /// A conversation everyone in the space reads.
    pub(crate) log: Uuid,
    /// Another conversation everyone reads.
    pub(crate) other_chat: Uuid,
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
            guest: Uuid::new_v4(),
            owner_agent: Uuid::new_v4(),
            member_agent: Uuid::new_v4(),
            log: Uuid::new_v4(),
            other_chat: Uuid::new_v4(),
            runtime: Uuid::new_v4(),
            other_machine: Uuid::new_v4(),
        }
    }

    async fn seed(&self, pool: &PgPool, label: &str) -> anyhow::Result<()> {
        for user in [self.owner, self.member, self.guest] {
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
                 values ($1, $2, 'builder'), ($1, $3, 'builder')",
                &[&self.project_id, &self.member, &self.guest],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&self.org_id, &self.project_id],
            )
            .await?;
        for (user, agent) in [
            (self.owner, self.owner_agent),
            (self.member, self.member_agent),
            (self.guest, Uuid::new_v4()),
        ] {
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
                    &[&agent, &user, &credential_id],
                )
                .await?;
        }
        for conversation in [self.log, self.other_chat] {
            connection
                .execute(
                    "insert into conversations (id, project_id, created_by, metadata, visibility)
                     values ($1, $2, $3, '{}'::jsonb, 'public')",
                    &[&conversation, &self.project_id, &self.owner],
                )
                .await?;
        }
        let mut capabilities = json!({ "agent": true, "origin": true, "grantedTurns": true });
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

/// `grants` turns device grants on, for the space's owner and member only:
/// its guest is a person the rollout's allowlist leaves out.
fn config(label: &str, space: &Space, grants: bool) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    if grants {
        config.device_grants = DeviceGrantUsers::Only(vec![space.owner, space.member]);
    }
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
    pub(crate) async fn send_as(
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
        eventually(&format!("queue entry {entry} to start a run"), || async {
            Ok(self.queue_entry(entry).await?.2)
        })
        .await
    }

    /// Ends every turn in the log, then drains the queue as the completion
    /// route would, and gives the job `entry` started.
    pub(crate) async fn drain(&self, entry: Uuid) -> anyhow::Result<SentJob> {
        self.end_turns().await?;
        crate::send_queue::recover_send_queue_batch(&self.state, None)
            .await
            .map_err(|(status, error)| anyhow::anyhow!("drain: {status} {}", error.message))?;
        job_of_run(&self.pool, self.dispatched_run(entry).await?).await
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
        sql_one(&self.pool, "select now()", &[]).await
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

    /// `runtime` completes `job` as its runtime reports it.
    pub(crate) async fn complete(
        &self,
        runtime: Uuid,
        job: Uuid,
        report: JsonValue,
    ) -> anyhow::Result<()> {
        let token = self.agent_token(runtime).await?;
        let mut body = json!({ "job_id": job });
        for (key, value) in report.as_object().expect("object") {
            body[key] = value.clone();
        }
        let (status, body) = self
            .call("POST", "/agent/complete", Some(&token), Some(body))
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "complete: {status} {body}");
        Ok(())
    }

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
    pub(crate) async fn device(
        &self,
        device_id: &str,
    ) -> anyhow::Result<(Option<Uuid>, Option<JsonValue>)> {
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

    /// What the device said of its state at its last heartbeat, as stored.
    pub(crate) async fn device_context(&self, device_id: &str) -> anyhow::Result<Option<String>> {
        sql_one(
            &self.pool,
            "select context from project_provider_devices
              where project_id = $1 and provider_id = $2 and device_id = $3",
            &[&self.space.project_id, &PROVIDER_ID, &device_id],
        )
        .await
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

    /// Inserts `request` into the space.
    pub(crate) async fn insert(&self, request: NewRequest<'_>) -> anyhow::Result<Uuid> {
        insert_request(&self.pool, self.space.project_id, request).await
    }

    /// A pending request `requested_by` made, for `target` or any device,
    /// and for `job` if a job made it.
    pub(crate) async fn request(
        &self,
        requested_by: Uuid,
        target: Option<&str>,
        job: Option<Uuid>,
    ) -> anyhow::Result<Uuid> {
        self.insert(NewRequest {
            requested_by: Some(requested_by),
            target,
            job,
            ..NewRequest::default()
        })
        .await
    }

    /// `job`'s provider requests, oldest first.
    pub(crate) async fn requests_of(&self, job: Uuid) -> anyhow::Result<Vec<Requested>> {
        Ok(self
            .pool
            .get()
            .await?
            .query(
                "select id, status, cancel_reason, error from project_provider_requests
                  where job_id = $1 order by created_at asc",
                &[&job],
            )
            .await?
            .iter()
            .map(|row| Requested {
                id: row.get(0),
                status: row.get(1),
                cancel_reason: row.get(2),
                error: row.get(3),
            })
            .collect())
    }

    /// The pending requests `token`'s holder lists, as `device_id` if given.
    pub(crate) async fn listed(
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
        Ok((status, listed_ids(&body)))
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

pub(crate) fn person() -> JsonValue {
    json!({ "input": { "kind": "person" } })
}

pub(crate) fn person_with(extra: JsonValue) -> JsonValue {
    let mut metadata = person();
    for (key, value) in extra.as_object().expect("object") {
        metadata[key] = value.clone();
    }
    metadata
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

pub(crate) struct SentJob {
    pub(crate) id: Uuid,
    pub(crate) trigger: Trigger,
}

/// What started a job: its message's stamped kind, if its message has one,
/// and the job's receive time.
#[derive(Debug, PartialEq)]
pub(crate) struct Trigger {
    pub(crate) kind: Option<String>,
    pub(crate) received_at: Option<DateTime<Utc>>,
}

pub(crate) async fn job_of_run(pool: &PgPool, run_id: Uuid) -> anyhow::Result<SentJob> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select j.id, j.trigger_received_at, m.metadata ->> 'trigger' as kind
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
    let users = vec![space.owner, space.member, space.guest];
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
        .merge(crate::device_grants::router())
        .merge(crate::message_search::router())
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
        metadata: Some(prompt_metadata(person())),
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
