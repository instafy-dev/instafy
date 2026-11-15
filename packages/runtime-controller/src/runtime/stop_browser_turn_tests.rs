//! A runtime stop of a Personal or Shared Browser turn, on the migrated
//! database (docs/Personal-Browser.md, docs/Shared-Browser.md). The stop's own
//! transaction fails only the turn's job, so it never locks the turn's chat
//! while it holds the runtime. The run's end, the one notification of its
//! failure and the give-back of its reserve are written once the stop has
//! committed (`record_failed_browser_turn`), and the idle sweep writes them
//! for a turn whose own write was lost (`sweeps::repair_stopped_browser_turns`).
//! Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use axum::Router;
use bb8_postgres::PostgresConnectionManager;
use chrono::Utc;
use serde_json::{json, Value as JsonValue};
use tokio::sync::{broadcast, Notify};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use super::{
    finish_failed_browser_turn, perform_runtime_stop, record_failed_browser_turn,
    stop_runtime_safely, BrowserTransport, FailedBrowserTurn, RecordedBrowserTurnEnd,
    SafeRuntimeStop, StopOptions, UNAVAILABLE_RUNTIME_INPUT_REJECTION,
};
use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::state::ControllerEvent;
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, eventually,
    require_origin_test_pool, spawn_aborting, sql, sql_one, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::{ApiError, AppState};

/// What every turn here was asked.
const SENT: &str = "Open the pricing page and read me the plans.";

/// How long a step that must not wait on a chat may take.
const WAIT: Duration = Duration::from_secs(10);

/// The provider of the space's hosted machines, which only these tests
/// configure: it runs them on a lease and releases them on a stop.
const RELEASING_PROVIDER: &str = "browser_turn_stop_test_machines";

/// How a job names its browser: the browser, the payload key it is under and
/// a spelling a stop reads as that browser.
type Spelling = (BrowserTransport, &'static str, &'static str);

/// Every way a job may name either browser.
const SPELLINGS: [Spelling; 4] = [
    (
        BrowserTransport::Personal,
        "browserTransport",
        "desktop-personal",
    ),
    (
        BrowserTransport::Personal,
        "browser_transport",
        " Desktop_Personal ",
    ),
    (BrowserTransport::Shared, "browserTransport", "shared"),
    (BrowserTransport::Shared, "browser_transport", "SHARED"),
];
const PERSONAL: Spelling = SPELLINGS[0];
const SHARED: Spelling = SPELLINGS[2];

/// What the provider does with a release of one of the space's hosted
/// machines.
#[derive(Clone)]
enum Release {
    Accept,
    Refuse,
    /// It tells `reached`, then answers once told on `respond`.
    Hold {
        reached: Arc<Notify>,
        respond: Arc<Notify>,
    },
}

/// A space whose owner and member each use it, with the owner's desktop.
struct Space {
    pool: PgPool,
    state: AppState,
    app: Router,
    project_id: Uuid,
    owner: Uuid,
    member: Uuid,
    /// The owner's own desktop, which runs their Personal and Shared Browser
    /// turns.
    desktop: Uuid,
}

/// A browser turn as a test sent it.
#[derive(Clone, Copy, Debug)]
struct Turn {
    job: Uuid,
    run: Uuid,
    prompt: Uuid,
    chat: Option<Uuid>,
}

/// What a runtime stop's own transaction did.
struct Stopped {
    status_changed: bool,
    skip_reason: Option<String>,
    personal: Vec<Uuid>,
    shared: Vec<Uuid>,
    turns: Vec<FailedBrowserTurn>,
}

impl Stopped {
    /// The browser turns it failed, each with its browser, in the order it
    /// failed them.
    fn failed(&self) -> Vec<(Uuid, BrowserTransport)> {
        self.turns
            .iter()
            .map(|turn| (turn.job_id, turn.transport))
            .collect()
    }

    fn turn(&self, job: Uuid) -> FailedBrowserTurn {
        self.turns
            .iter()
            .find(|turn| turn.job_id == job)
            .cloned()
            .expect("the stop failed the turn")
    }
}

fn api(error: (StatusCode, Json<ApiError>)) -> anyhow::Error {
    let (status, Json(error)) = error;
    anyhow::anyhow!("{status}: {}", error.message)
}

fn stop_options(reason: &str) -> StopOptions {
    StopOptions {
        source: "browser_turn_stop_test",
        reason: Some(reason.to_string()),
        skip_if_active_jobs: false,
        require_idle_timeout: false,
        allow_cleanup_pending_release: false,
        expected_identity: None,
    }
}

/// Runs `body` on a fresh space whose config `configure` may change, with a
/// provider that treats a release as `release` says, then deletes the space
/// and its people, however `body` ends, a failed assertion included.
async fn with_space<C, F, Fut>(
    label: &str,
    release: Release,
    configure: C,
    body: F,
) -> anyhow::Result<()>
where
    C: FnOnce(&mut AppConfig),
    F: FnOnce(Space) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let pool = require_origin_test_pool(label).await?;
    let provider_app = Router::new().route(
        "/runtime/release",
        axum::routing::post(move || {
            let release = release.clone();
            async move {
                match release {
                    Release::Accept => StatusCode::NO_CONTENT,
                    Release::Refuse => StatusCode::INTERNAL_SERVER_ERROR,
                    Release::Hold { reached, respond } => {
                        reached.notify_one();
                        respond.notified().await;
                        StatusCode::NO_CONTENT
                    }
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let _provider = spawn_aborting(async move {
        axum::serve(listener, provider_app)
            .await
            .expect("serve the browser turn stop test provider");
    });

    let (org_id, project_id, owner, member, desktop) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.runtime_providers.push(RuntimeProviderConfig {
        id: RELEASING_PROVIDER.to_string(),
        display_name: "Browser turn stop test".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{address}")),
        auth_token: None,
        metadata: None,
    });
    configure(&mut config);
    let state = build_test_state(pool.clone(), config);
    let app = Router::new()
        .merge(crate::runtime::router())
        .with_state(state.clone());
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id],
    };
    let users = vec![owner, member];
    let body_pool = pool.clone();
    let label = label.to_string();
    // The shared fixture deletes the space however its body ends, and then
    // goes on with a panic; the people go after it.
    let result = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(
        with_shared_db_fixture(fixture, async move {
            for user in [owner, member] {
                ensure_test_user(&body_pool, &user).await?;
            }
            let connection = body_pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, $3)",
                    &[&org_id, &format!("{label}-{org_id}"), &label],
                )
                .await?;
            connection
                .execute(
                    "insert into org_memberships (org_id, user_id, role)
                     values ($1, $2, 'owner'), ($1, $3, 'builder')",
                    &[&org_id, &owner, &member],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                     values ($1, $2, $3, $4, 'customer', 'active')",
                    &[&project_id, &org_id, &label, &owner],
                )
                .await?;
            connection
                .execute(
                    "insert into project_memberships (project_id, user_id, role)
                     values ($1, $2, 'builder')",
                    &[&project_id, &member],
                )
                .await?;
            let mut capabilities = json!({ "agent": true, "origin": true });
            crate::runtime::set_self_hosted_access_attestation(
                capabilities.as_object_mut().expect("capabilities"),
                owner,
            );
            connection
                .execute(
                    "insert into runtimes (
                         id, project_id, provider, status, idle_ttl_seconds, last_seen_at,
                         capabilities
                     ) values ($1, $2, 'self-hosted', 'ready', 600, now(), $3)",
                    &[&desktop, &project_id, &PgJson(capabilities)],
                )
                .await?;
            drop(connection);
            body(Space {
                pool: body_pool,
                state,
                app,
                project_id,
                owner,
                member,
                desktop,
            })
            .await
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
                eprintln!(
                    "[browser turn stop tests] could not delete the space's people: {error:#}"
                );
            }
            std::panic::resume_unwind(panic)
        }
    }
}

impl Space {
    /// A new conversation of the owner's that everyone in the space reads.
    async fn chat(&self) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        sql(
            &self.pool,
            "insert into conversations (id, project_id, created_by, metadata, visibility)
             values ($1, $2, $3, '{}'::jsonb, 'public')",
            &[&id, &self.project_id, &self.owner],
        )
        .await?;
        Ok(id)
    }

    /// A chat an automation of the owner's posts to.
    async fn automation_chat(&self) -> anyhow::Result<Uuid> {
        let chat = Uuid::new_v4();
        sql(
            &self.pool,
            "insert into conversations (
                 id, project_id, created_by, metadata, visibility, thread_kind
             ) values ($1, $2, $3, '{}'::jsonb, 'private', 'automation')",
            &[&chat, &self.project_id, &self.owner],
        )
        .await?;
        sql(
            &self.pool,
            "insert into conversation_participants (conversation_id, user_id, role, added_by)
             values ($1, $2, 'owner', $2)",
            &[&chat, &self.owner],
        )
        .await?;
        sql(
            &self.pool,
            "insert into automations (
                 id, project_id, user_id, name, prompt_text, schedule_kind,
                 interval_hours, timezone, runtime_mode, conversation_id, status,
                 next_run_at
             ) values (
                 $1, $2, $3, 'Pricing check', 'Read me the plans.', 'hourly', 24, 'UTC',
                 'existing', $4, 'active', now() + interval '1 day'
             )",
            &[&Uuid::new_v4(), &self.project_id, &self.owner, &chat],
        )
        .await?;
        Ok(chat)
    }

    /// A chat of the space's internal review, which notifies no one.
    async fn internal_chat(&self) -> anyhow::Result<Uuid> {
        let chat = self.chat().await?;
        sql(
            &self.pool,
            "update conversations set internal_purpose = 'space_review' where id = $1",
            &[&chat],
        )
        .await?;
        Ok(chat)
    }

    /// A machine of the space's that the test provider runs on an active
    /// lease, and releases on a stop.
    async fn hosted(&self) -> anyhow::Result<Uuid> {
        let (runtime, lease) = (Uuid::new_v4(), Uuid::new_v4());
        sql(
            &self.pool,
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, idle_ttl_seconds, last_seen_at
             ) values ($1, $2, $3, 'ready', 'http://runtime.test', 600, now())",
            &[&runtime, &self.project_id, &RELEASING_PROVIDER],
        )
        .await?;
        sql(
            &self.pool,
            "insert into runtime_leases (
                 id, project_id, runtime_id, status, requested_at, launched_at
             ) values ($1, $2, $3, 'active', now(), now())",
            &[&lease, &self.project_id, &runtime],
        )
        .await?;
        sql(
            &self.pool,
            "update runtimes set active_lease_id = $2 where id = $1",
            &[&runtime, &lease],
        )
        .await?;
        Ok(runtime)
    }

    /// A browser turn `sender` sent, in `chat` or in none, leased by
    /// `runtime` or queued for it, whose job names its browser as `spelling`
    /// does.
    async fn turn(
        &self,
        runtime: Uuid,
        spelling: Spelling,
        chat: Option<Uuid>,
        sender: Uuid,
        leased: bool,
    ) -> anyhow::Result<Turn> {
        let (prompt, run) = (Uuid::new_v4(), Uuid::new_v4());
        sql(
            &self.pool,
            "insert into prompts (id, project_id, conversation_id, user_id, intent, prompt_text)
             values ($1, $2, $3, $4, 'feature', $5)",
            &[&prompt, &self.project_id, &chat, &sender, &SENT],
        )
        .await?;
        let (status, progress, stage) = if leased {
            ("in_progress", 40.0_f64, "agent:leased")
        } else {
            ("queued", 0.0_f64, "agent:queued")
        };
        sql(
            &self.pool,
            "insert into runs (
                 id, project_id, conversation_id, prompt_id, run_type, status, progress,
                 progress_stage
             ) values ($1, $2, $3, $4, 'prompt', $5, $6, $7)",
            &[
                &run,
                &self.project_id,
                &chat,
                &prompt,
                &status,
                &progress,
                &stage,
            ],
        )
        .await?;
        self.job_of(run, prompt, chat, runtime, spelling, sender, leased)
            .await
    }

    /// Another job of the run `run`, as [`Self::turn`] makes one.
    #[allow(clippy::too_many_arguments)]
    async fn job_of(
        &self,
        run: Uuid,
        prompt: Uuid,
        chat: Option<Uuid>,
        runtime: Uuid,
        spelling: Spelling,
        sender: Uuid,
        leased: bool,
    ) -> anyhow::Result<Turn> {
        let job = Uuid::new_v4();
        let (_, key, value) = spelling;
        let mut metadata = serde_json::Map::new();
        metadata.insert(key.to_string(), json!(value));
        let payload = json!({
            "prompt_text": SENT,
            "prompt_id": prompt,
            "user_id": sender,
            "metadata": metadata,
        });
        sql(
            &self.pool,
            "insert into agent_jobs (
                 id, project_id, run_id, prompt_id, conversation_id, intent, status, payload,
                 target_runtime_id, leased_by_runtime_id, leased_at, lease_expires_at,
                 lease_attempts
             ) values (
                 $1, $2, $3, $4, $5, 'feature', $6, $7, $8::uuid,
                 case when $9::boolean then $8::uuid else null end,
                 case when $9::boolean then now() else null end,
                 case when $9::boolean then now() + interval '10 minutes' else null end,
                 case when $9::boolean then 1 else 0 end
             )",
            &[
                &job,
                &self.project_id,
                &run,
                &prompt,
                &chat,
                &if leased { "leased" } else { "queued" },
                &PgJson(payload),
                &runtime,
                &leased,
            ],
        )
        .await?;
        Ok(Turn {
            job,
            run,
            prompt,
            chat,
        })
    }

    /// An input someone sent into `turn` that its runtime never took.
    async fn pending_input(&self, turn: &Turn) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        sql(
            &self.pool,
            "insert into agent_job_inputs (
                 id, project_id, conversation_id, job_id, run_id, created_by, client_send_id,
                 lease_attempt, target_turn_id, sequence, request
             ) values ($1, $2, $3, $4, $5, $6, $7, 1, 'turn-1', 1, '{}'::jsonb)",
            &[
                &id,
                &self.project_id,
                &turn.chat.expect("an input goes to a chat"),
                &turn.job,
                &turn.run,
                &self.owner,
                &format!("send-{id}"),
            ],
        )
        .await?;
        Ok(id)
    }

    /// A runtime stop's own transaction for `runtime`, committed, as every
    /// stop of a runtime makes it (`perform_runtime_stop`), and nothing after
    /// it: no turn's end is written.
    async fn stop_only(&self, runtime: Uuid) -> anyhow::Result<Stopped> {
        let mut connection = self.pool.get().await?;
        let transaction = connection.transaction().await?;
        let details = crate::runtime::fetch_runtime_for_update(&transaction, &runtime)
            .await
            .map_err(api)?;
        let outcome = perform_runtime_stop(&transaction, &details, stop_options("unit_test"))
            .await
            .map_err(api)?;
        transaction.commit().await?;
        Ok(Stopped {
            status_changed: outcome.status_changed,
            skip_reason: outcome.skip_reason,
            personal: outcome.failed_personal_browser_jobs,
            shared: outcome.failed_shared_browser_jobs,
            turns: outcome.failed_browser_turns,
        })
    }

    /// A stop of `runtime` as the controller's own stops make it
    /// (`stop_runtime_safely`), the provider's release of a hosted machine
    /// included.
    async fn stop_safely(
        &self,
        runtime: Uuid,
    ) -> Result<SafeRuntimeStop, (StatusCode, Json<ApiError>)> {
        stop_runtime_safely(&self.state, &runtime, stop_options("idle_stop")).await
    }

    /// Writes what a stop leaves of a browser turn it failed, as the stop's
    /// publish does once it has committed: what it wrote.
    async fn record(&self, turn: &FailedBrowserTurn) -> anyhow::Result<RecordedBrowserTurnEnd> {
        record_failed_browser_turn(&self.state, turn)
            .await
            .map_err(api)
    }

    /// Brings `runtime` back after a stop.
    async fn restart(&self, runtime: Uuid) -> anyhow::Result<()> {
        sql(
            &self.pool,
            "update runtimes set status = 'ready', last_seen_at = now() where id = $1",
            &[&runtime],
        )
        .await?;
        Ok(())
    }

    /// `runtime`'s agent token in its current launch, which is ready.
    async fn agent_token(&self, runtime: Uuid) -> anyhow::Result<String> {
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
        let generation =
            crate::runtime::runtime_generation_from_capabilities(&row.get::<_, JsonValue>(1))
                .map_err(api)?;
        Ok(crate::auth::issue_agent_token(
            &self.state.config,
            &self.project_id,
            &runtime,
            lease_id.as_ref(),
            generation,
        )
        .map_err(api)?
        .token)
    }

    fn user_token(&self, user: Uuid) -> String {
        crate::auth::issue_controller_token(&self.state.config, &user)
            .expect("user token")
            .token
    }

    /// Runs one tick of the controller's idle sweep, with the space held as
    /// active in memory, so its idle release requeues none of its leases.
    async fn sweep(&self) -> anyhow::Result<()> {
        self.state
            .runtime_activity
            .mark_active(self.project_id, Some(600), Some(Utc::now()))
            .await;
        crate::runtime::sweep_idle_activity(&self.state).await
    }

    /// Moves the end of `job`, a turn a runtime stop failed, `seconds` into
    /// the past.
    async fn stopped_ago(&self, job: Uuid, seconds: i64) -> anyhow::Result<()> {
        sql(
            &self.pool,
            "update agent_jobs set completed_at = now() - $2::bigint * interval '1 second'
              where id = $1",
            &[&job, &seconds],
        )
        .await?;
        Ok(())
    }

    async fn run_status(&self, run: Uuid) -> anyhow::Result<String> {
        sql_one(&self.pool, "select status from runs where id = $1", &[&run]).await
    }

    async fn runtime_status(&self, runtime: Uuid) -> anyhow::Result<String> {
        sql_one(
            &self.pool,
            "select status from runtimes where id = $1",
            &[&runtime],
        )
        .await
    }

    /// Waits for `run` to fail.
    async fn ended(&self, run: Uuid) -> anyhow::Result<()> {
        eventually(&format!("run {run} to fail"), || async {
            Ok((self.run_status(run).await? == "failed").then_some(()))
        })
        .await
    }

    /// `job` as a stop leaves a browser turn's: failed with the sentence of
    /// its `transport`, its lease, input readiness and heartbeat cleared and
    /// its end recorded, still pinned to `runtime`, never requeued.
    async fn assert_job_failed(
        &self,
        job: Uuid,
        transport: BrowserTransport,
        runtime: Uuid,
    ) -> anyhow::Result<()> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, outcome, summary, error_message, target_runtime_id,
                        leased_by_runtime_id is null and lease_expires_at is null
                          and active_input_ready_runtime_id is null
                          and active_input_ready_expires_at is null
                          and active_input_ready_turn_id is null
                          and heartbeat_at is null,
                        completed_at is not null,
                        payload ? 'requeuedReason'
                   from agent_jobs where id = $1",
                &[&job],
            )
            .await?;
        let sentence = Some(transport.sentence().to_string());
        assert_eq!(
            (
                row.get::<_, String>(0),
                row.get::<_, Option<String>>(1),
                row.get::<_, Option<String>>(2),
                row.get::<_, Option<String>>(3),
                row.get::<_, Option<Uuid>>(4),
                row.get::<_, bool>(5),
                row.get::<_, bool>(6),
                row.get::<_, bool>(7),
            ),
            (
                "failed".to_string(),
                Some("failed".to_string()),
                sentence.clone(),
                sentence,
                Some(runtime),
                true,
                true,
                false,
            ),
            "job {job}"
        );
        Ok(())
    }

    /// The durable notifications of `run`'s end: each one's producer key and
    /// its recipients, in order.
    async fn notified(&self, run: Uuid) -> anyhow::Result<Vec<(String, Vec<Uuid>)>> {
        Ok(self
            .pool
            .get()
            .await?
            .query(
                "select event.producer_key,
                        coalesce(array_agg(recipient.user_id order by recipient.user_id)
                                     filter (where recipient.user_id is not null),
                                 '{}')
                   from notification_events event
                   left join notification_recipients recipient on recipient.event_id = event.id
                  where event.producer_key = any($1)
                  group by event.producer_key
                  order by event.producer_key",
                &[&vec![
                    format!("run.failed:{run}"),
                    format!("automation.failed:run:{run}"),
                ]],
            )
            .await?
            .iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect())
    }

    /// The notification of a failed run in an ordinary chat of the owner's:
    /// one `run.failed`, which reaches them.
    fn the_chat_hears(&self, run: Uuid) -> Vec<(String, Vec<Uuid>)> {
        vec![(format!("run.failed:{run}"), vec![self.owner])]
    }

    /// The notification of a failed run with no chat: its sender and the
    /// space's owner hear of it.
    fn its_people_hear(&self, run: Uuid, sender: Uuid) -> Vec<(String, Vec<Uuid>)> {
        let mut people = vec![sender, self.owner];
        people.sort_unstable();
        people.dedup();
        vec![(format!("run.failed:{run}"), people)]
    }

    /// `turn`'s run ended once, as a stop of a `transport` turn ends it, and
    /// `heard` is each notification of it and who got it. No message, reply
    /// notification or Home row came of it.
    async fn assert_ended_once(
        &self,
        turn: &Turn,
        transport: BrowserTransport,
        heard: Vec<(String, Vec<Uuid>)>,
        what: &str,
    ) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        let run = connection
            .query_one(
                "select status, progress, progress_stage, last_message from runs where id = $1",
                &[&turn.run],
            )
            .await?;
        assert_eq!(
            (
                run.get::<_, String>(0),
                run.get::<_, f64>(1),
                run.get::<_, Option<String>>(2),
                run.get::<_, Option<String>>(3),
            ),
            (
                "failed".to_string(),
                100.0,
                None,
                Some(transport.sentence().to_string()),
            ),
            "{what}: the run"
        );
        assert_eq!(self.notified(turn.run).await?, heard, "{what}: notified");
        let wrote = connection
            .query_one(
                "select (select count(*) from conversation_messages where run_id = $1),
                        (select count(*) from activity_events where run_id = $1),
                        (select count(*) from notification_events
                          where event_name = 'conversation.reply' and conversation_id = $2)",
                &[&turn.run, &turn.chat],
            )
            .await?;
        assert_eq!(
            (
                wrote.get::<_, i64>(0),
                wrote.get::<_, i64>(1),
                wrote.get::<_, i64>(2)
            ),
            (0, 0, 0),
            "{what}: messages, Home rows and replies"
        );
        Ok(())
    }

    /// A state of the controller's on a pool of its own, whose connections
    /// give up on a lock they wait for after `lock_timeout`.
    async fn impatient(&self, lock_timeout: &str) -> anyhow::Result<AppState> {
        let mut config: tokio_postgres::Config = std::env::var("TEST_DATABASE_URL")?.parse()?;
        config.options(&format!("-c lock_timeout={lock_timeout}"));
        let pool = bb8::Pool::builder()
            .max_size(2)
            .build(PostgresConnectionManager::new(
                config,
                crate::config::database_tls(),
            ))
            .await?;
        Ok(build_test_state(pool, self.state.config.clone()))
    }
}

/// Waits until at least `count` sessions of the test database wait on a lock.
async fn lock_waiters(pool: &PgPool, count: i64) -> anyhow::Result<()> {
    eventually(&format!("{count} sessions to wait on a lock"), || async {
        let waiting: i64 = sql_one(
            pool,
            "select count(*) from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'",
            &[],
        )
        .await?;
        Ok((waiting >= count).then_some(()))
    })
    .await
}

/// What has been published so far.
fn published(events: &mut broadcast::Receiver<ControllerEvent>) -> Vec<ControllerEvent> {
    let mut published = Vec::new();
    while let Ok(event) = events.try_recv() {
        published.push(event);
    }
    published
}

/// What `published` holds of `run`'s end: each `run.completed`'s data.
fn ends_of(published: &[ControllerEvent], run: Uuid) -> Vec<JsonValue> {
    published
        .iter()
        .filter(|event| event.kind == "run.completed" && event.run_id == Some(run))
        .map(|event| event.data.clone())
        .collect()
}

/// What is published until `run` ends, and for half a second after.
async fn published_until_ended(
    events: &mut broadcast::Receiver<ControllerEvent>,
    run: Uuid,
) -> anyhow::Result<Vec<ControllerEvent>> {
    let mut published = Vec::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "run {run} never ended: {:?}",
                    published
                        .iter()
                        .map(|event: &ControllerEvent| event.kind.clone())
                        .collect::<Vec<_>>()
                )
            })??;
        let ended = event.kind == "run.completed" && event.run_id == Some(run);
        published.push(event);
        if ended {
            break;
        }
    }
    let settled = tokio::time::Instant::now() + Duration::from_millis(500);
    while let Ok(Ok(event)) = tokio::time::timeout_at(settled, events.recv()).await {
        published.push(event);
    }
    Ok(published)
}

/// `run`'s end as a write publishes it for a `transport` turn: failed, with
/// the turn's sentence and its browser's `failureCode`, and the run itself.
fn assert_published_end(data: &JsonValue, run: Uuid, transport: BrowserTransport) {
    assert_eq!(data["finalStatus"], json!("failed"), "{data}");
    assert_eq!(data["errorMessage"], json!(transport.sentence()), "{data}");
    assert_eq!(
        data["failureCode"],
        json!(transport.failure_code()),
        "{data}"
    );
    assert_eq!(data["run"]["id"], json!(run), "{data}");
}

/// A runtime stop never locks its browser turn's chat while it holds the
/// runtime's row: a dispatch into that chat holds the chat's row
/// (`ensure_conversation_record`) while it waits for the runtime's, and the
/// notification of a failed run locks the chat's row at its commit, so the
/// two would deadlock. The stop's own transaction fails only the turn's job,
/// whichever browser it ran in and however its job names it. The run ends
/// once the stop has committed, in a write that holds no runtime and waits
/// for the chat, and everyone in the chat hears of it once. Written again, it
/// ends nothing twice.
#[tokio::test]
async fn a_runtime_stop_never_waits_on_its_browser_turns_chat() -> anyhow::Result<()> {
    with_space(
        "browser-stop-lock-order",
        Release::Accept,
        |_| {},
        |space| async move {
            for spelling in SPELLINGS {
                let (transport, key, value) = spelling;
                let what = format!("{key} {value:?}");
                let chat = space.chat().await?;
                let turn = space
                    .turn(space.desktop, spelling, Some(chat), space.owner, true)
                    .await?;

                // A dispatch into the turn's chat holds the chat's row.
                let mut dispatch_connection = space.pool.get().await?;
                let dispatch = dispatch_connection.transaction().await?;
                dispatch
                    .query_one(
                        "select id from conversations where id = $1 for update",
                        &[&chat],
                    )
                    .await?;
                // The stop commits without waiting on it.
                let stopped = tokio::time::timeout(WAIT, space.stop_only(space.desktop))
                    .await
                    .map_err(|_| anyhow::anyhow!("{what}: the stop waited on its turn's chat"))??;
                assert_eq!(stopped.failed(), vec![(turn.job, transport)], "{what}");
                space
                    .assert_job_failed(turn.job, transport, space.desktop)
                    .await?;
                assert_eq!(
                    space.run_status(turn.run).await?,
                    "in_progress",
                    "{what}: not yet"
                );
                assert!(space.notified(turn.run).await?.is_empty(), "{what}");

                // The run's end waits for the chat, holding nothing the
                // dispatch needs: the dispatch takes the runtime's row next,
                // and commits.
                let recorder = {
                    let state = space.state.clone();
                    let failed = stopped.turn(turn.job);
                    spawn_aborting(async move {
                        record_failed_browser_turn(&state, &failed)
                            .await
                            .map_err(api)
                    })
                };
                lock_waiters(&space.pool, 1).await?;
                tokio::time::timeout(
                    WAIT,
                    dispatch.query_one(
                        "select id from runtimes where id = $1 for share",
                        &[&space.desktop],
                    ),
                )
                .await
                .map_err(|_| anyhow::anyhow!("{what}: the dispatch waited on the runtime"))??;
                dispatch.commit().await?;
                drop(dispatch_connection);
                let recorded = tokio::time::timeout(WAIT, recorder)
                    .await
                    .map_err(|_| anyhow::anyhow!("{what}: the run's end never got the chat"))???;
                assert_eq!(
                    recorded,
                    RecordedBrowserTurnEnd {
                        ended_run: true,
                        refunded_org_id: None,
                    },
                    "{what}"
                );
                space
                    .assert_ended_once(&turn, transport, space.the_chat_hears(turn.run), &what)
                    .await?;

                // Written again, it ends nothing twice.
                let again = space.record(&stopped.turn(turn.job)).await?;
                assert_eq!(again, RecordedBrowserTurnEnd::default(), "{what}");
                space
                    .assert_ended_once(&turn, transport, space.the_chat_hears(turn.run), &what)
                    .await?;
                space.restart(space.desktop).await?;
            }
            Ok(())
        },
    )
    .await
}

/// The same for a hosted machine the controller stops on its own
/// (`stop_runtime_safely`), which quarantines it, waits for its provider's
/// release and finalizes the stop: the stop finishes while dispatches hold
/// the chats of both its browser turns, and each turn's run ends once they
/// let go.
#[tokio::test]
async fn a_safe_stop_of_a_hosted_machine_never_waits_on_its_browser_turns_chats(
) -> anyhow::Result<()> {
    with_space(
        "browser-stop-lock-order-hosted",
        Release::Accept,
        |_| {},
        |space| async move {
            let machine = space.hosted().await?;
            let (personal_chat, shared_chat) = (space.chat().await?, space.chat().await?);
            let turns = [
                (
                    space
                        .turn(
                            machine,
                            SPELLINGS[1],
                            Some(personal_chat),
                            space.owner,
                            false,
                        )
                        .await?,
                    BrowserTransport::Personal,
                ),
                (
                    space
                        .turn(machine, SPELLINGS[3], Some(shared_chat), space.owner, true)
                        .await?,
                    BrowserTransport::Shared,
                ),
            ];

            let mut dispatch_connection = space.pool.get().await?;
            let dispatch = dispatch_connection.transaction().await?;
            for chat in [personal_chat, shared_chat] {
                dispatch
                    .query_one(
                        "select id from conversations where id = $1 for update",
                        &[&chat],
                    )
                    .await?;
            }
            let stopped = tokio::time::timeout(WAIT, space.stop_safely(machine))
                .await
                .map_err(|_| anyhow::anyhow!("the stop waited on its turns' chats"))?
                .map_err(api)?;
            assert!(stopped.outcome.status_changed);
            assert_eq!(space.runtime_status(machine).await?, "stopped");
            for (turn, transport) in &turns {
                space
                    .assert_job_failed(turn.job, *transport, machine)
                    .await?;
                assert_ne!(space.run_status(turn.run).await?, "failed", "not yet");
                assert!(space.notified(turn.run).await?.is_empty());
            }

            tokio::time::timeout(
                WAIT,
                dispatch.query_one(
                    "select id from runtimes where id = $1 for share",
                    &[&machine],
                ),
            )
            .await
            .map_err(|_| anyhow::anyhow!("the dispatch waited on the machine"))??;
            dispatch.commit().await?;
            drop(dispatch_connection);
            for (turn, transport) in &turns {
                space.ended(turn.run).await?;
                space
                    .assert_ended_once(
                        turn,
                        *transport,
                        space.the_chat_hears(turn.run),
                        "a hosted machine's stop",
                    )
                    .await?;
            }
            Ok(())
        },
    )
    .await
}

/// A stopped browser turn's run fails once, so everyone it concerns hears of
/// it once, through the notification of a failed run: in an automation's chat
/// its owner gets `automation.failed` in place of `run.failed`, a chat of the
/// space's internal review notifies no one, and a run two stopped jobs share
/// ends once. Written again, nothing more comes of any of them.
#[tokio::test]
async fn a_stopped_browser_turns_run_fails_once_in_any_chat() -> anyhow::Result<()> {
    with_space(
        "browser-stop-notified-once",
        Release::Accept,
        |_| {},
        |space| async move {
            let automation_chat = space.automation_chat().await?;
            let automation = space
                .turn(
                    space.desktop,
                    SHARED,
                    Some(automation_chat),
                    space.owner,
                    true,
                )
                .await?;
            let internal = space
                .turn(
                    space.desktop,
                    PERSONAL,
                    Some(space.internal_chat().await?),
                    space.owner,
                    true,
                )
                .await?;
            let shared_run_chat = space.chat().await?;
            let first = space
                .turn(
                    space.desktop,
                    SHARED,
                    Some(shared_run_chat),
                    space.owner,
                    true,
                )
                .await?;
            let second = space
                .job_of(
                    first.run,
                    first.prompt,
                    first.chat,
                    space.desktop,
                    SPELLINGS[3],
                    space.owner,
                    false,
                )
                .await?;

            let stopped = space.stop_only(space.desktop).await?;
            let mut failed = stopped.failed();
            failed.sort_unstable_by_key(|(job, _)| *job);
            let mut expected = vec![
                (automation.job, BrowserTransport::Shared),
                (internal.job, BrowserTransport::Personal),
                (first.job, BrowserTransport::Shared),
                (second.job, BrowserTransport::Shared),
            ];
            expected.sort_unstable_by_key(|(job, _)| *job);
            assert_eq!(failed, expected);
            let mut ended = Vec::new();
            for turn in &stopped.turns {
                if space.record(turn).await?.ended_run {
                    ended.push(turn.job_id);
                }
            }
            let ended_by = |job: Uuid| ended.iter().filter(|ended| **ended == job).count();
            assert_eq!(ended_by(automation.job), 1, "{ended:?}");
            assert_eq!(ended_by(internal.job), 1, "{ended:?}");
            assert_eq!(
                ended_by(first.job) + ended_by(second.job),
                1,
                "the run two jobs share ends once: {ended:?}"
            );

            for _ in 0..2 {
                space
                    .assert_ended_once(
                        &automation,
                        BrowserTransport::Shared,
                        vec![(
                            format!("automation.failed:run:{}", automation.run),
                            vec![space.owner],
                        )],
                        "an automation's chat",
                    )
                    .await?;
                space
                    .assert_ended_once(
                        &internal,
                        BrowserTransport::Personal,
                        vec![],
                        "an internal chat",
                    )
                    .await?;
                space
                    .assert_ended_once(
                        &first,
                        BrowserTransport::Shared,
                        space.the_chat_hears(first.run),
                        "a run two jobs share",
                    )
                    .await?;
                // Written again, each ends nothing.
                for turn in &stopped.turns {
                    assert_eq!(
                        space.record(turn).await?,
                        RecordedBrowserTurnEnd::default(),
                        "{turn:?}"
                    );
                }
            }
            Ok(())
        },
    )
    .await
}

/// Two writers of one stopped browser turn's end at once, the stop's own and
/// the idle sweep's repair (on this controller or another), end its run once:
/// the second waits for the run's row while the first holds it, then finds
/// the run ended and writes nothing. In a chat, both first wait for another
/// transaction's `for update` of the chat. A run with no chat notifies its
/// sender and the space's owner.
#[tokio::test]
async fn two_writers_of_a_stopped_browser_turns_end_end_its_run_once() -> anyhow::Result<()> {
    with_space(
        "browser-stop-two-writers",
        Release::Accept,
        |_| {},
        |space| async move {
            let chat = space.chat().await?;
            let in_chat = space
                .turn(space.desktop, SHARED, Some(chat), space.owner, true)
                .await?;
            let chatless = space
                .turn(space.desktop, PERSONAL, None, space.member, false)
                .await?;
            let stopped = space.stop_only(space.desktop).await?;

            for (turn, transport, held, holds, heard) in [
                (
                    in_chat,
                    BrowserTransport::Shared,
                    chat,
                    "select id from conversations where id = $1 for update",
                    space.the_chat_hears(in_chat.run),
                ),
                (
                    chatless,
                    BrowserTransport::Personal,
                    chatless.run,
                    "select id from runs where id = $1 for update",
                    space.its_people_hear(chatless.run, space.member),
                ),
            ] {
                // Both start while another transaction holds the row they
                // wait on, so each is under way before either commits.
                let mut holder_connection = space.pool.get().await?;
                let holder = holder_connection.transaction().await?;
                holder.query_one(holds, &[&held]).await?;
                let writers = [0, 1].map(|_| {
                    let state = space.state.clone();
                    let failed = stopped.turn(turn.job);
                    spawn_aborting(async move {
                        record_failed_browser_turn(&state, &failed)
                            .await
                            .map_err(api)
                    })
                });
                lock_waiters(&space.pool, 2).await?;
                holder.commit().await?;
                drop(holder_connection);
                let mut ends = Vec::new();
                for writer in writers {
                    let recorded = tokio::time::timeout(WAIT, writer)
                        .await
                        .map_err(|_| anyhow::anyhow!("a writer never finished"))???;
                    ends.push(recorded.ended_run);
                }
                ends.sort_unstable();
                assert_eq!(ends, vec![false, true], "{transport:?}: one ended it");
                space
                    .assert_ended_once(&turn, transport, heard, "two writers")
                    .await?;
            }
            Ok(())
        },
    )
    .await
}

/// What a runtime stop publishes for a browser turn it failed: right after
/// the stop, the rejection of an input sent into the turn that its runtime
/// never took, and once the turn's run has ended, one `run.completed` with
/// the turn's sentence and its browser's `failureCode`. It publishes no
/// failure message, and gives no reserve back for a turn that did not run on
/// Instafy AI. The same holds whether the runtime agent stops its own desktop
/// on its way out (`POST /runtime/stop`) or the controller stops a hosted
/// machine.
#[tokio::test]
async fn a_runtime_stop_publishes_its_browser_turns_end() -> anyhow::Result<()> {
    with_space(
        "browser-stop-publish",
        Release::Accept,
        |_| {},
        |space| async move {
            let chat = space.chat().await?;
            let turn = space
                .turn(space.desktop, SHARED, Some(chat), space.owner, true)
                .await?;
            let input = space.pending_input(&turn).await?;
            let machine = space.hosted().await?;
            let hosted = space
                .turn(
                    machine,
                    PERSONAL,
                    Some(space.chat().await?),
                    space.owner,
                    true,
                )
                .await?;
            // A `credits.updated` reaches this node's broadcast only for a
            // space an open event stream watches.
            let _watch = space.state.events.watch_project(space.project_id);
            let mut events = space.state.events.subscribe();

            let token = space.agent_token(space.desktop).await?;
            let (status, body) = call_router(
                &space.app,
                Some(&format!("Bearer {token}")),
                "POST",
                "/runtime/stop".to_string(),
                Some(json!({ "runtime_id": space.desktop, "reason": "agent_shutdown" })),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            space
                .assert_job_failed(turn.job, BrowserTransport::Shared, space.desktop)
                .await?;
            let stop_published = published_until_ended(&mut events, turn.run).await?;

            space.stop_safely(machine).await.map_err(api)?;
            let safe_stop_published = published_until_ended(&mut events, hosted.run).await?;

            for (published, turn, transport, what) in [
                (
                    &stop_published,
                    turn,
                    BrowserTransport::Shared,
                    "the agent's own stop",
                ),
                (
                    &safe_stop_published,
                    hosted,
                    BrowserTransport::Personal,
                    "the controller's stop",
                ),
            ] {
                let kinds = published
                    .iter()
                    .map(|event| event.kind.as_str())
                    .collect::<Vec<_>>();
                let ends = ends_of(published, turn.run);
                assert_eq!(ends.len(), 1, "{what}: {kinds:?}");
                assert_published_end(&ends[0], turn.run, transport);
                assert!(
                    !published.iter().any(|event| {
                        event.kind == "conversation.message_created"
                            && [
                                json!(BrowserTransport::Personal.failure_code()),
                                json!(BrowserTransport::Shared.failure_code()),
                            ]
                            .contains(&event.data["metadata"]["kind"])
                    }),
                    "{what}: a failure message was published: {kinds:?}"
                );
                assert_eq!(
                    published
                        .iter()
                        .filter(|event| event.kind == crate::credits::CREDITS_UPDATED_EVENT)
                        .count(),
                    0,
                    "{what}: {kinds:?}"
                );
                space
                    .assert_ended_once(&turn, transport, space.the_chat_hears(turn.run), what)
                    .await?;
            }

            // The input the desktop never took is rejected as the stop
            // commits, before the turn's run ends.
            let rejected = stop_published
                .iter()
                .position(|event| {
                    event.kind == "agent.jobInput" && event.data["commandId"] == json!(input)
                })
                .expect("the input's rejection was published");
            assert_eq!(
                stop_published[rejected].data["state"],
                json!("rejected"),
                "{:?}",
                stop_published[rejected].data
            );
            assert_eq!(
                stop_published[rejected].data["errorMessage"],
                json!(UNAVAILABLE_RUNTIME_INPUT_REJECTION)
            );
            let ended = stop_published
                .iter()
                .position(|event| event.kind == "run.completed" && event.run_id == Some(turn.run))
                .expect("the run's end was published");
            assert!(rejected < ended, "the rejection came first");
            let input_status: String = sql_one(
                &space.pool,
                "select status from agent_job_inputs where id = $1",
                &[&input],
            )
            .await?;
            assert_eq!(input_status, "rejected");
            Ok(())
        },
    )
    .await
}

/// A runtime stop's own write of its browser turn's end may never commit:
/// the controller exits first, a pool-retirement drain among them. Inside
/// that write's grace the idle sweep leaves the turn to it; past it, the
/// sweep ends the run, which notifies once, and publishes it once. A second
/// sweep writes and publishes nothing more.
#[tokio::test]
async fn the_idle_sweep_ends_a_stopped_browser_turns_run_its_stop_never_ended() -> anyhow::Result<()>
{
    with_space(
        "browser-stop-repair",
        Release::Accept,
        |_| {},
        |space| async move {
            let chat = space.chat().await?;
            let turn = space
                .turn(space.desktop, PERSONAL, Some(chat), space.owner, true)
                .await?;
            // The stop commits, and its own write never runs.
            let stopped = space.stop_only(space.desktop).await?;
            assert_eq!(stopped.personal, vec![turn.job]);
            let mut events = space.state.events.subscribe();

            space.sweep().await?;
            assert_eq!(
                space.run_status(turn.run).await?,
                "in_progress",
                "inside the grace"
            );
            assert!(ends_of(&published(&mut events), turn.run).is_empty());

            space.stopped_ago(turn.job, 61).await?;
            space.sweep().await?;
            space
                .assert_ended_once(
                    &turn,
                    BrowserTransport::Personal,
                    space.the_chat_hears(turn.run),
                    "the sweep's write",
                )
                .await?;
            let ends = ends_of(&published(&mut events), turn.run);
            assert_eq!(ends.len(), 1, "{ends:?}");
            assert_published_end(&ends[0], turn.run, BrowserTransport::Personal);

            space.sweep().await?;
            space
                .assert_ended_once(
                    &turn,
                    BrowserTransport::Personal,
                    space.the_chat_hears(turn.run),
                    "a second sweep",
                )
                .await?;
            assert!(ends_of(&published(&mut events), turn.run).is_empty());
            Ok(())
        },
    )
    .await
}

/// When every try of a stop's own write of its browser turn's end fails
/// (here each gives up waiting for the turn's chat), it publishes nothing
/// and leaves the run as the stop left it, so no Studio shows an end that a
/// reload would not. Once the chat is free and the grace has passed, the
/// idle sweep ends the run and publishes it once.
#[tokio::test]
async fn a_stopped_browser_turns_end_whose_every_try_fails_is_left_to_the_sweep(
) -> anyhow::Result<()> {
    with_space(
        "browser-stop-every-try-fails",
        Release::Accept,
        |_| {},
        |space| async move {
            let chat = space.chat().await?;
            let turn = space
                .turn(space.desktop, SHARED, Some(chat), space.owner, true)
                .await?;
            let stopped = space.stop_only(space.desktop).await?;
            let impatient = space.impatient("100ms").await?;
            let mut impatient_events = impatient.events.subscribe();
            let mut events = space.state.events.subscribe();

            let mut holder_connection = space.pool.get().await?;
            let holder = holder_connection.transaction().await?;
            holder
                .query_one(
                    "select id from conversations where id = $1 for update",
                    &[&chat],
                )
                .await?;
            tokio::time::timeout(
                WAIT,
                finish_failed_browser_turn(&impatient, &stopped.turn(turn.job)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("the write kept trying"))?;
            holder.commit().await?;
            drop(holder_connection);
            assert_eq!(space.run_status(turn.run).await?, "in_progress");
            assert!(space.notified(turn.run).await?.is_empty());
            assert!(ends_of(&published(&mut impatient_events), turn.run).is_empty());

            space.stopped_ago(turn.job, 61).await?;
            space.sweep().await?;
            space
                .assert_ended_once(
                    &turn,
                    BrowserTransport::Shared,
                    space.the_chat_hears(turn.run),
                    "the sweep's write",
                )
                .await?;
            let ends = ends_of(&published(&mut events), turn.run);
            assert_eq!(ends.len(), 1, "{ends:?}");
            assert_published_end(&ends[0], turn.run, BrowserTransport::Shared);
            Ok(())
        },
    )
    .await
}

/// The idle sweep ends the run of a browser turn a stop failed only within a
/// day of the stop, and only for a turn a stop failed: a browser turn that
/// failed otherwise, and a stopped turn whose run something else ended since
/// (a space's delete cancels it), keep their runs as they are, and nothing is
/// notified or published for them.
#[tokio::test]
async fn the_idle_sweep_ends_only_the_runs_of_recently_stopped_browser_turns() -> anyhow::Result<()>
{
    with_space(
        "browser-stop-repair-bounds",
        Release::Accept,
        |_| {},
        |space| async move {
            let old = space
                .turn(
                    space.desktop,
                    SHARED,
                    Some(space.chat().await?),
                    space.owner,
                    true,
                )
                .await?;
            let canceled = space
                .turn(
                    space.desktop,
                    PERSONAL,
                    Some(space.chat().await?),
                    space.owner,
                    true,
                )
                .await?;
            let stopped = space.stop_only(space.desktop).await?;
            assert_eq!(stopped.turns.len(), 2);
            // A browser turn its own completion failed, with an error of its
            // own, two minutes ago.
            let otherwise = space
                .turn(
                    space.desktop,
                    SHARED,
                    Some(space.chat().await?),
                    space.owner,
                    false,
                )
                .await?;
            sql(
                &space.pool,
                "update agent_jobs
                    set status = 'failed', outcome = 'failed',
                        error_message = 'Octo could not open the page.',
                        completed_at = now() - interval '2 minutes'
                  where id = $1",
                &[&otherwise.job],
            )
            .await?;
            sql(
                &space.pool,
                "update runs set status = 'canceled' where id = $1",
                &[&canceled.run],
            )
            .await?;
            space.stopped_ago(old.job, 24 * 60 * 60 + 60).await?;
            space.stopped_ago(canceled.job, 61).await?;
            let mut events = space.state.events.subscribe();

            space.sweep().await?;
            let published = published(&mut events);
            for (turn, status, what) in [
                (old, "in_progress", "stopped more than a day ago"),
                (otherwise, "queued", "failed otherwise"),
                (canceled, "canceled", "canceled since its stop"),
            ] {
                assert_eq!(space.run_status(turn.run).await?, status, "{what}");
                assert!(space.notified(turn.run).await?.is_empty(), "{what}");
                assert!(ends_of(&published, turn.run).is_empty(), "{what}");
            }
            assert_eq!(
                space.record(&stopped.turn(canceled.job)).await?,
                RecordedBrowserTurnEnd::default(),
                "a canceled run is not ended again"
            );

            // Within the day, the old one's run ends.
            space.stopped_ago(old.job, 61).await?;
            space.sweep().await?;
            space
                .assert_ended_once(
                    &old,
                    BrowserTransport::Shared,
                    space.the_chat_hears(old.run),
                    "within the day",
                )
                .await?;
            assert_eq!(space.run_status(canceled.run).await?, "canceled");
            Ok(())
        },
    )
    .await
}

/// A stop of a hosted machine quarantines it, commits, then waits for its
/// provider's release, which can take minutes. The run of each browser turn
/// the quarantine failed ends once the quarantine has committed, before the
/// release returns. The stop's last transaction, once the release has
/// returned, fails only the browser turns that appeared since, whose runs end
/// once it commits. Each run ends, and is notified, once.
#[tokio::test]
async fn a_hosted_stop_ends_its_browser_turns_runs_before_and_after_its_release(
) -> anyhow::Result<()> {
    let (reached, respond) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let release = Release::Hold {
        reached: reached.clone(),
        respond: respond.clone(),
    };
    with_space(
        "browser-stop-quarantine",
        release,
        |_| {},
        |space| async move {
            let machine = space.hosted().await?;
            let first = space
                .turn(
                    machine,
                    SHARED,
                    Some(space.chat().await?),
                    space.owner,
                    true,
                )
                .await?;
            let stop = {
                let state = space.state.clone();
                spawn_aborting(async move {
                    stop_runtime_safely(&state, &machine, stop_options("idle_stop"))
                        .await
                        .map(|stopped| stopped.outcome.failed_browser_turns.len())
                        .map_err(api)
                })
            };
            tokio::time::timeout(WAIT, reached.notified())
                .await
                .map_err(|_| anyhow::anyhow!("the stop never asked for the release"))?;
            space
                .assert_job_failed(first.job, BrowserTransport::Shared, machine)
                .await?;
            space.ended(first.run).await?;
            space
                .assert_ended_once(
                    &first,
                    BrowserTransport::Shared,
                    space.the_chat_hears(first.run),
                    "before the release",
                )
                .await?;

            // A turn queued for the machine while it is released.
            let late = space
                .turn(
                    machine,
                    PERSONAL,
                    Some(space.chat().await?),
                    space.owner,
                    false,
                )
                .await?;
            respond.notify_one();
            let finalized = tokio::time::timeout(WAIT, stop)
                .await
                .map_err(|_| anyhow::anyhow!("the stop never finished"))???;
            assert_eq!(
                finalized, 1,
                "the last transaction failed the late turn alone"
            );
            assert_eq!(space.runtime_status(machine).await?, "stopped");
            space
                .assert_job_failed(late.job, BrowserTransport::Personal, machine)
                .await?;
            space.ended(late.run).await?;
            space
                .assert_ended_once(
                    &late,
                    BrowserTransport::Personal,
                    space.the_chat_hears(late.run),
                    "after the release",
                )
                .await?;
            space
                .assert_ended_once(
                    &first,
                    BrowserTransport::Shared,
                    space.the_chat_hears(first.run),
                    "after the release",
                )
                .await?;
            Ok(())
        },
    )
    .await
}

/// When the provider refuses the release, the stop fails and leaves its
/// machine quarantined for a retry, but the run of each browser turn its
/// quarantine failed still ends, once.
#[tokio::test]
async fn a_hosted_stop_whose_release_fails_still_ends_its_browser_turns_runs() -> anyhow::Result<()>
{
    with_space(
        "browser-stop-release-refused",
        Release::Refuse,
        |_| {},
        |space| async move {
            let machine = space.hosted().await?;
            let turn = space
                .turn(
                    machine,
                    SHARED,
                    Some(space.chat().await?),
                    space.owner,
                    true,
                )
                .await?;
            let (status, _) = space
                .stop_safely(machine)
                .await
                .err()
                .expect("the release was refused");
            assert_eq!(status, StatusCode::BAD_GATEWAY);
            assert_eq!(
                space.runtime_status(machine).await?,
                "requested",
                "quarantined for a retry"
            );
            space
                .assert_job_failed(turn.job, BrowserTransport::Shared, machine)
                .await?;
            space.ended(turn.run).await?;
            space
                .assert_ended_once(
                    &turn,
                    BrowserTransport::Shared,
                    space.the_chat_hears(turn.run),
                    "a refused release",
                )
                .await?;
            Ok(())
        },
    )
    .await
}

/// The dev-only offline switch fails a desktop's browser turns as a stop
/// does: their runs end once it has committed.
#[tokio::test]
async fn the_dev_offline_switch_ends_its_browser_turns_runs() -> anyhow::Result<()> {
    with_space(
        "browser-stop-dev-offline",
        Release::Accept,
        |config| config.dev_mode = true,
        |space| async move {
            let turn = space
                .turn(
                    space.desktop,
                    PERSONAL,
                    Some(space.chat().await?),
                    space.owner,
                    false,
                )
                .await?;
            let (status, body) = call_router(
                &space.app,
                Some(&format!("Bearer {}", space.user_token(space.owner))),
                "POST",
                format!("/runtime/offline/{}", space.project_id),
                Some(json!({ "runtime_id": space.desktop })),
            )
            .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
            assert_eq!(space.runtime_status(space.desktop).await?, "offline");
            space
                .assert_job_failed(turn.job, BrowserTransport::Personal, space.desktop)
                .await?;
            space.ended(turn.run).await?;
            space
                .assert_ended_once(
                    &turn,
                    BrowserTransport::Personal,
                    space.the_chat_hears(turn.run),
                    "the offline switch",
                )
                .await?;
            Ok(())
        },
    )
    .await
}

/// A dispatch racing just behind a stop commits its browser turn only once
/// the runtime is stopped. A repeated stop still fails that turn, as a change
/// though the runtime was already stopped, and the turn's run ends after it.
#[tokio::test]
async fn a_repeated_stop_fails_a_raced_browser_turn_and_ends_its_run() -> anyhow::Result<()> {
    with_space(
        "browser-stop-repeated",
        Release::Accept,
        |_| {},
        |space| async move {
            let first = space.stop_only(space.desktop).await?;
            assert!(first.status_changed && first.turns.is_empty());
            let raced = space
                .turn(
                    space.desktop,
                    SPELLINGS[1],
                    Some(space.chat().await?),
                    space.owner,
                    false,
                )
                .await?;
            let repeated = space.stop_only(space.desktop).await?;
            assert!(repeated.status_changed);
            assert_eq!(repeated.skip_reason.as_deref(), Some("already_stopped"));
            assert_eq!(repeated.personal, vec![raced.job]);
            assert!(repeated.shared.is_empty());
            space
                .assert_job_failed(raced.job, BrowserTransport::Personal, space.desktop)
                .await?;
            assert_eq!(space.run_status(raced.run).await?, "queued", "not yet");
            assert!(space.record(&repeated.turn(raced.job)).await?.ended_run);
            space
                .assert_ended_once(
                    &raced,
                    BrowserTransport::Personal,
                    space.the_chat_hears(raced.run),
                    "a repeated stop",
                )
                .await?;
            Ok(())
        },
    )
    .await
}

/// A chat deleted between a stop and the write of its browser turn's end (as
/// a space's delete deletes it) takes the turn's run and job with it, since
/// both belong to the chat. The write finds no chat to lock and no run to
/// end: it ends nothing and fails nothing, so it is not tried again, and
/// nothing is notified or published. The idle sweep finds nothing left to
/// repair.
#[tokio::test]
async fn a_chat_deleted_after_the_stop_leaves_its_browser_turns_end_nothing_to_write(
) -> anyhow::Result<()> {
    with_space(
        "browser-stop-chat-deleted",
        Release::Accept,
        |_| {},
        |space| async move {
            let chat = space.chat().await?;
            let turn = space
                .turn(space.desktop, SHARED, Some(chat), space.member, true)
                .await?;
            let stopped = space.stop_only(space.desktop).await?;
            let _watch = space.state.events.watch_project(space.project_id);
            let mut events = space.state.events.subscribe();
            sql(
                &space.pool,
                "delete from conversations where id = $1",
                &[&chat],
            )
            .await?;
            let left: i64 = sql_one(
                &space.pool,
                "select (select count(*) from runs where id = $1)
                        + (select count(*) from agent_jobs where id = $2)",
                &[&turn.run, &turn.job],
            )
            .await?;
            assert_eq!(left, 0, "the chat took its run and job with it");

            assert_eq!(
                space.record(&stopped.turn(turn.job)).await?,
                RecordedBrowserTurnEnd::default()
            );
            tokio::time::timeout(
                WAIT,
                finish_failed_browser_turn(&space.state, &stopped.turn(turn.job)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("the write kept trying"))?;
            space.sweep().await?;
            assert!(space.notified(turn.run).await?.is_empty());
            let published = published(&mut events);
            assert!(ends_of(&published, turn.run).is_empty());
            assert!(
                !published
                    .iter()
                    .any(|event| event.kind == crate::credits::CREDITS_UPDATED_EVENT
                        && event.project_id == Some(space.project_id)),
                "{:?}",
                published
                    .iter()
                    .map(|event| event.kind.as_str())
                    .collect::<Vec<_>>()
            );
            Ok(())
        },
    )
    .await
}
