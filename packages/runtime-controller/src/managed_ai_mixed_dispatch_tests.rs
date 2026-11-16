//! One message to two agents: Octo on Instafy AI and `@helper`, a saved agent
//! on the person's own OpenAI key. The prompt holds one managed reserve, and
//! only its managed job settles it or gives it back. The own-key job's tokens
//! are billed by the person's own account (docs/Credits-Billing.md), so it
//! carries none of the managed markers that completion reconciliation and the
//! failed-turn refunds read per job.

use super::*;

/// The task ref `lease_job_to_space_runtime` leases through, so the hosted
/// runtime the message is sent on is the one that answers both jobs.
const SPACE_RUNTIME_TASK_REF: &str = "agent-route-test-runtime";

/// What dispatch stamps for a managed target's reserve and a dispatch with no
/// managed target never sets.
const MANAGED_RESERVE_KEYS: [&str; 9] = [
    "managedAiLabel",
    "managedAiProvider",
    "managedAiModelLabel",
    "managedAiCreditBurnAmount",
    "managedAiDailyPromptLimit",
    "managedAiDailyPromptsUsedBeforeBurn",
    "managedAiBillingDeferred",
    "creditSnapshot",
    "managedAiCredit",
];

/// A turn's (input, output) tokens as Codex reports them, none cached.
type Tokens = (u64, u64);

/// Five credits at the fixture's prices, against the one-credit reserve.
const MANAGED_TOKENS: Tokens = (4_000, 2_000);
const MANAGED_CHARGE: i32 = 5;
/// Fourteen credits at the same prices, were they charged in credits.
const OWN_KEY_TOKENS: Tokens = (8_000, 6_000);

const MANAGED_REPLY: &str = "Here is the release plan.";
const OWN_KEY_REPLY: &str = "The release tests look right.";

/// The provider refused the person's own key before any model answered.
const OWN_KEY_REFUSED: &str = "unexpected status 401 Unauthorized: Incorrect API key provided, url: https://api.openai.com/v1/responses";

type LedgerRow = (String, i32, Option<String>);

struct MixedSpace {
    pool: PgPool,
    config: AppConfig,
    state: AppState,
    owner_user_id: Uuid,
    org_id: Uuid,
    project_id: Uuid,
    runtime_id: Uuid,
    credential_id: Uuid,
}

/// One of the message's two jobs, as dispatch queued it.
struct QueuedJob {
    job_id: Uuid,
    run_id: Uuid,
    payload: serde_json::Value,
}

struct MixedDispatch {
    prompt_id: Uuid,
    managed: QueuedJob,
    own_key: QueuedJob,
}

impl MixedDispatch {
    fn reserve_key(&self) -> String {
        format!("managed-ai-prompt:{}", self.prompt_id)
    }

    fn adjustment_key(&self) -> String {
        format!("managed-ai-adjustment:{}", self.prompt_id)
    }
}

impl MixedSpace {
    /// The owner has no default AI connection, so Octo answers on Instafy AI,
    /// and `@helper` answers on the owner's own key. The org holds 20 credits
    /// and a hosted runtime is ready.
    async fn seed(label: &str) -> anyhow::Result<Self> {
        let pool = require_origin_test_pool(label).await?;
        let mut config =
            build_app_config(test_origin_private_key(), test_origin_public_key(), label);
        // The controller holds the managed key, so the managed gate passes
        // without a proxy.
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
        // Pinned prices, so a production rate change cannot rewrite the charges.
        config.managed_ai_input_usd_micros_per_1k = 250;
        config.managed_ai_cached_input_usd_micros_per_1k = 25;
        config.managed_ai_output_usd_micros_per_1k = 2_000;
        config.billing_units_per_usd = 1_000;
        let space = Self {
            state: build_test_state(pool.clone(), config.clone()),
            pool,
            config,
            owner_user_id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            credential_id: Uuid::new_v4(),
        };
        if let Err(error) = space.insert_rows().await {
            let _ = space.cleanup().await;
            return Err(error);
        }
        Ok(space)
    }

    async fn insert_rows(&self) -> anyhow::Result<()> {
        ensure_test_user(&self.pool, &self.owner_user_id).await?;
        let connection = self.pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name)
                 values ($1, $2, 'Mixed managed and own-key dispatch')",
                &[&self.org_id, &format!("mixed-dispatch-{}", self.org_id)],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&self.org_id, &self.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, owner_user_id, project_type, status)
                 values ($1, $2, $3, 'customer', 'active')",
                &[&self.project_id, &self.org_id, &self.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&self.org_id, &self.project_id],
            )
            .await?;
        // Not the default connection: only `@helper` uses it.
        connection
            .execute(
                "insert into user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
                 ) values ($1, $2, 'openai_api_key', 'Own OpenAI key',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, false)",
                &[&self.credential_id, &self.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into user_agents (id, user_id, provider, handle, avatar_seed, credential_id)
                 values ($1, $3, 'openai', 'octo', 'octo', null),
                        ($2, $3, 'openai', 'helper', 'helper', $4)",
                &[
                    &Uuid::new_v4(),
                    &Uuid::new_v4(),
                    &self.owner_user_id,
                    &self.credential_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) values ($1, $2, 'instafy-cloud', 'ready', 'http://runtime.invalid', $3,
                     600, now(), '{\"agent\": true, \"origin\": true}'::jsonb)",
                &[&self.runtime_id, &self.project_id, &SPACE_RUNTIME_TASK_REF],
            )
            .await?;
        Ok(())
    }

    /// The owner sends one message to Octo and `@helper` on the hosted runtime.
    async fn dispatch(&self) -> anyhow::Result<MixedDispatch> {
        let request = dispatch::normalize_dispatch_request(DispatchPromptRequest {
            project_id: Some(self.project_id.to_string()),
            session_id: None,
            prompt_text: Some(
                "@octo outline the release plan. @helper review the release tests.".to_string(),
            ),
            intent: Some("feature".to_string()),
            plan_seed: None,
            metadata: Some(json!({
                "clientMessageId": Uuid::new_v4().to_string(),
                "agentSelection": {
                    "active": ["octo", "helper"],
                    "mentions": ["octo", "helper"]
                }
            })),
            conversation_metadata: Some(json!({ "visibility": "private" })),
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: Some(Uuid::new_v4().to_string()),
            runtime_id: Some(self.runtime_id.to_string()),
            runtime_display_name: None,
            prefer_runtime: None,
        })
        .map_err(|error| controller_error("normalize the mixed dispatch", error))?;
        let response = dispatch::process_dispatch_prompt(
            &self.state,
            &RequestContext {
                user_id: Some(self.owner_user_id),
                is_service_role: false,
                scoped_claims: None,
            },
            request,
        )
        .await
        .map_err(|error| controller_error("dispatch to a managed and an own-key agent", error))?;
        assert_eq!(response.status, "queued");
        let prompt_id = response.prompt_id.expect("the message's prompt");

        let rows = self
            .pool
            .get()
            .await?
            .query(
                "select id, run_id, credential_id, payload from agent_jobs
                 where project_id = $1 and prompt_id = $2",
                &[&self.project_id, &prompt_id],
            )
            .await?;
        assert_eq!(rows.len(), 2, "one job per agent");
        let (mut managed, mut own_key) = (None, None);
        for row in rows {
            let job = QueuedJob {
                job_id: row.get("id"),
                run_id: row
                    .get::<_, Option<Uuid>>("run_id")
                    .expect("a dispatched job has a run"),
                payload: row.get::<_, PgJson<serde_json::Value>>("payload").0,
            };
            match row.get::<_, Option<Uuid>>("credential_id") {
                None => managed = Some(job),
                Some(credential_id) => {
                    assert_eq!(credential_id, self.credential_id);
                    own_key = Some(job);
                }
            }
        }
        let dispatched = MixedDispatch {
            prompt_id,
            managed: managed.expect("Octo's job runs on Instafy AI"),
            own_key: own_key.expect("@helper's job runs on its own key"),
        };
        assert_eq!(
            dispatched.managed.payload["metadata"]["agent"]["handle"],
            json!("octo")
        );
        assert_eq!(
            dispatched.own_key.payload["metadata"]["agent"]["handle"],
            json!("helper")
        );
        Ok(dispatched)
    }

    /// The runtime ends `job` with `reply`, reporting `tokens` for its turn.
    async fn answer(&self, job: &QueuedJob, reply: &str, tokens: Tokens) -> anyhow::Result<()> {
        let (input_tokens, output_tokens) = tokens;
        self.complete(
            job,
            json!({
                "job_id": job.job_id,
                "outcome": "succeeded",
                "summary": reply,
                "artifacts": [{
                    "kind": "codex/run-log",
                    "events": [{
                        "type": "turn.completed",
                        "usage": {
                            "input_tokens": input_tokens,
                            "cached_input_tokens": 0,
                            "output_tokens": output_tokens
                        }
                    }]
                }],
            }),
        )
        .await
    }

    async fn complete(&self, job: &QueuedJob, body: serde_json::Value) -> anyhow::Result<()> {
        let token =
            lease_job_to_space_runtime(&self.pool, &self.config, &self.project_id, &job.job_id)
                .await?;
        let status = post_agent_endpoint(&self.state, &token, "/agent/complete", body).await?;
        anyhow::ensure!(
            status == StatusCode::OK,
            "completing job {} answered {status}",
            job.job_id
        );
        Ok(())
    }

    /// The space's managed-AI ledger rows, oldest first. The seed and the
    /// reserve burn's auto-refill are not this contract.
    async fn managed_ledger(&self) -> anyhow::Result<Vec<LedgerRow>> {
        let rows = self
            .pool
            .get()
            .await?
            .query(
                "select reason, delta, idempotency_key from org_credit_ledger
                 where project_id = $1
                   and reason in ('managed_ai_prompt', 'managed_ai_adjustment', 'managed_ai_refund')
                 order by created_at, reason",
                &[&self.project_id],
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

    async fn ledger_metadata(&self, idempotency_key: &str) -> anyhow::Result<serde_json::Value> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select metadata from org_credit_ledger
                 where project_id = $1 and idempotency_key = $2",
                &[&self.project_id, &idempotency_key],
            )
            .await?
            .get::<_, PgJson<serde_json::Value>>("metadata")
            .0)
    }

    async fn metadata_of(&self, table: &str, id: &Uuid) -> anyhow::Result<serde_json::Value> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                &format!("select metadata from {table} where id = $1"),
                &[id],
            )
            .await?
            .get::<_, PgJson<serde_json::Value>>("metadata")
            .0)
    }

    /// The metadata of the reply `job`'s run persisted with `content`.
    async fn reply_metadata(
        &self,
        job: &QueuedJob,
        content: &str,
    ) -> anyhow::Result<serde_json::Value> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select metadata from conversation_messages
                 where run_id = $1 and role = 'assistant' and content = $2",
                &[&job.run_id, &content],
            )
            .await?
            .get::<_, PgJson<serde_json::Value>>("metadata")
            .0)
    }

    /// What GET /me/credentials/requirements reports as dailyPromptsUsed.
    async fn daily_prompts_used(&self) -> anyhow::Result<i32> {
        let mut connection = self.pool.get().await?;
        let transaction = connection.transaction().await?;
        let count = credentials::count_recent_managed_ai_prompts(
            &transaction,
            Some(self.owner_user_id),
            Utc::now() - ChronoDuration::hours(24),
        )
        .await
        .map_err(|error| controller_error("count managed AI prompts", error))?;
        transaction.commit().await?;
        Ok(count)
    }

    async fn cleanup(&self) -> anyhow::Result<()> {
        let project = cleanup_origin_project(&self.pool, &self.project_id).await;
        let org = cleanup_org(&self.pool, &self.org_id).await;
        let user = cleanup_test_user(&self.pool, &self.owner_user_id).await;
        project.and(org).and(user)
    }
}

fn assert_no_managed_reserve_keys(metadata: &serde_json::Value, what: &str) {
    for key in MANAGED_RESERVE_KEYS {
        assert!(
            metadata.get(key).is_none(),
            "{what} carries no {key}: {metadata}"
        );
    }
}

/// Dispatch stamps the managed markers on the managed target alone: its job,
/// its run and the reserve's trace. The own-key job and run get what a
/// dispatch with no managed target gives them. The prompt, which holds the one
/// reserve and counts once toward the day's prompts, stays managed.
#[tokio::test]
async fn mixed_dispatch_stamps_managed_markers_on_the_managed_target_alone() -> anyhow::Result<()> {
    let space = MixedSpace::seed("mixed-dispatch-markers").await?;
    let result = async {
        let dispatched = space.dispatch().await?;
        let reserve_key = dispatched.reserve_key();

        let managed = &dispatched.managed.payload["metadata"];
        assert_eq!(managed["aiAccessMode"], json!("managed"));
        assert_eq!(managed["managedAiUsed"], json!(true));
        assert_eq!(
            managed["managedAiCredit"]["reserve"]["idempotencyKey"],
            json!(reserve_key)
        );
        let own_key = &dispatched.own_key.payload["metadata"];
        assert_eq!(own_key["aiAccessMode"], json!("byoc"));
        assert_eq!(own_key["managedAiUsed"], json!(false));
        assert_no_managed_reserve_keys(own_key, "the own-key job");

        let managed_run = space
            .metadata_of("runs", &dispatched.managed.run_id)
            .await?;
        assert_eq!(managed_run["aiAccessMode"], json!("managed"));
        assert_eq!(managed_run["managedAiUsed"], json!(true));
        assert_eq!(
            managed_run["managedAiCredit"]["reserve"]["idempotencyKey"],
            json!(reserve_key)
        );
        let own_key_run = space
            .metadata_of("runs", &dispatched.own_key.run_id)
            .await?;
        assert_eq!(own_key_run["aiAccessMode"], json!("byoc"));
        assert_eq!(own_key_run["managedAiUsed"], json!(false));
        assert_no_managed_reserve_keys(&own_key_run, "the own-key run");

        let prompt = space.metadata_of("prompts", &dispatched.prompt_id).await?;
        assert_eq!(prompt["aiAccessMode"], json!("managed"));
        assert_eq!(prompt["managedAiUsed"], json!(true));
        assert_eq!(space.daily_prompts_used().await?, 1);
        assert_eq!(
            space.managed_ledger().await?,
            vec![(
                "managed_ai_prompt".to_string(),
                -space.config.managed_ai_credit_burn_amount,
                Some(reserve_key)
            )]
        );
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    result.and(cleanup)
}

/// The own-key reply ends first. Its tokens are not charged in credits, its
/// reply is worded as the person's own connection's, and the prompt's
/// adjustment waits for the managed reply, measured from that reply's tokens.
#[tokio::test]
async fn managed_reply_settles_the_reserve_when_the_own_key_reply_ends_first() -> anyhow::Result<()>
{
    let space = MixedSpace::seed("mixed-dispatch-own-key-first").await?;
    let result = async {
        let dispatched = space.dispatch().await?;
        let reserve_key = dispatched.reserve_key();
        let adjustment_key = dispatched.adjustment_key();
        let reserve_units = space.config.managed_ai_credit_burn_amount;
        let reserve_row = (
            "managed_ai_prompt".to_string(),
            -reserve_units,
            Some(reserve_key.clone()),
        );

        space
            .answer(&dispatched.own_key, OWN_KEY_REPLY, OWN_KEY_TOKENS)
            .await?;
        assert_eq!(
            space.managed_ledger().await?,
            vec![reserve_row.clone()],
            "the own-key reply writes no managed adjustment"
        );
        let own_key_run = space
            .metadata_of("runs", &dispatched.own_key.run_id)
            .await?;
        assert_eq!(own_key_run["aiAccessMode"], json!("byoc"));
        assert_no_managed_reserve_keys(&own_key_run, "the own-key run once it ends");
        assert_eq!(
            space
                .reply_metadata(&dispatched.own_key, OWN_KEY_REPLY)
                .await?["aiAccessMode"],
            json!("byoc"),
            "the own-key reply is worded as the person's own connection's"
        );

        space
            .answer(&dispatched.managed, MANAGED_REPLY, MANAGED_TOKENS)
            .await?;
        assert_eq!(
            space.managed_ledger().await?,
            vec![
                reserve_row,
                (
                    "managed_ai_adjustment".to_string(),
                    -(MANAGED_CHARGE - reserve_units),
                    Some(adjustment_key.clone())
                ),
            ],
            "the prompt is charged the managed reply's tokens, once"
        );
        let managed_usage = json!({
            "input_tokens": MANAGED_TOKENS.0,
            "cached_input_tokens": 0,
            "output_tokens": MANAGED_TOKENS.1,
        });
        assert_eq!(
            space.ledger_metadata(&adjustment_key).await?["usage"],
            managed_usage
        );
        let reserve = space.ledger_metadata(&reserve_key).await?;
        assert_eq!(reserve["usage"], managed_usage);
        assert_eq!(reserve["cost"]["chargedUnits"], json!(MANAGED_CHARGE));
        let managed_run = space
            .metadata_of("runs", &dispatched.managed.run_id)
            .await?;
        assert_eq!(
            managed_run["managedAiCredit"]["charge"]["chargedUnits"],
            json!(MANAGED_CHARGE)
        );
        assert_eq!(
            space
                .reply_metadata(&dispatched.managed, MANAGED_REPLY)
                .await?["aiAccessMode"],
            json!("managed")
        );
        assert_eq!(space.daily_prompts_used().await?, 1);
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    result.and(cleanup)
}

/// The provider refuses the person's own key before any model answers. That
/// gives back nothing of Instafy AI's: the managed reply still runs on the
/// prompt's reserve and daily slot, and settles them with its own tokens.
#[tokio::test]
async fn own_key_refusal_keeps_the_managed_reserve_and_daily_slot() -> anyhow::Result<()> {
    let space = MixedSpace::seed("mixed-dispatch-own-key-refused").await?;
    let result = async {
        let dispatched = space.dispatch().await?;
        let reserve_units = space.config.managed_ai_credit_burn_amount;
        let reserve_row = (
            "managed_ai_prompt".to_string(),
            -reserve_units,
            Some(dispatched.reserve_key()),
        );

        space
            .complete(
                &dispatched.own_key,
                json!({
                    "job_id": dispatched.own_key.job_id,
                    "outcome": "failed",
                    "error_message": OWN_KEY_REFUSED,
                    "artifacts": [],
                }),
            )
            .await?;
        assert_eq!(
            space.managed_ledger().await?,
            vec![reserve_row.clone()],
            "the own-key refusal refunds nothing"
        );
        let prompt = space.metadata_of("prompts", &dispatched.prompt_id).await?;
        assert_eq!(prompt["managedAiUsed"], json!(true));
        assert_eq!(space.daily_prompts_used().await?, 1);
        let own_key_run = space
            .metadata_of("runs", &dispatched.own_key.run_id)
            .await?;
        assert_eq!(own_key_run["aiAccessMode"], json!("byoc"));
        assert_eq!(own_key_run["managedAiUsed"], json!(false));
        assert_no_managed_reserve_keys(&own_key_run, "the refused own-key run");

        space
            .answer(&dispatched.managed, MANAGED_REPLY, MANAGED_TOKENS)
            .await?;
        assert_eq!(
            space.managed_ledger().await?,
            vec![
                reserve_row,
                (
                    "managed_ai_adjustment".to_string(),
                    -(MANAGED_CHARGE - reserve_units),
                    Some(dispatched.adjustment_key())
                ),
            ],
            "the managed reply is charged in full"
        );
        assert_eq!(space.daily_prompts_used().await?, 1);
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    result.and(cleanup)
}
