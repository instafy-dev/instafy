//! Only the runtime that leased a job ends it or posts to it, for every job,
//! as local-engine turns had it first (docs/Self-Hosted-Runtime-Security.md).
//! `/agent/complete` and `/agent/message` refuse a token that names no
//! runtime, whatever STRICT_MODE says, and take a job only while it is
//! leased by the token's own runtime: never another runtime's job, and never
//! one in the queue, whether no runtime ever leased it or a runtime lost it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::tests::{
    build_app_config, build_test_state, call_router, sql, sql_one, test_origin_private_key,
    test_origin_public_key,
};
use crate::tests_provider_space::{person, with_space, Harness};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};

/// A failure the proxy refused before any model answered: a managed turn's
/// reserve comes back on it.
const PROXY_REFUSED: &str = "unexpected status 401 Unauthorized: proxy token missing credential_id for BYOC request, url: http://proxy:8789/v1/responses";

/// A short upstream rate limit before the turn acted: the job goes back in
/// the queue on it (crate::turn_rate_limit_retry).
const RATE_LIMITED: &str = "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 7.632s.";

/// A token that names no runtime, which any write member mints by asking for
/// fewer scopes than a machine's, is refused by both job routes before they
/// read anything, with STRICT_MODE off as on: it ends no job and posts to
/// none. The state's database cannot be reached, so a route that went past
/// the refusal would fail instead.
#[tokio::test]
async fn a_token_that_names_no_runtime_ends_no_job_and_posts_to_none() -> anyhow::Result<()> {
    let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
        "host=/nonexistent/instafy-agent-route-test user=postgres dbname=postgres",
        crate::config::database_tls(),
    )?;
    let pool = bb8::Pool::builder()
        .max_size(1)
        .connection_timeout(Duration::from_millis(500))
        .build_unchecked(manager);
    let project_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    for strict_mode in [false, true] {
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "no-runtime-agent-token",
        );
        config.strict_mode = strict_mode;
        let token = mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: project_id.to_string(),
                subject: Uuid::new_v4().to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: None,
                protocol: None,
                scopes: vec!["agent.complete".to_string(), "agent.message".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|(status, error)| anyhow::anyhow!("mint: {status} {}", error.0.message))?
        .token;
        let app = router().with_state(build_test_state(pool.clone(), config));
        let refusal = if strict_mode {
            "agent token missing runtime scope while strict mode is enabled"
        } else {
            "agent token missing runtime scope"
        };
        for (path, body) in [
            (
                "/agent/complete",
                json!({ "job_id": job_id, "outcome": "succeeded", "summary": "Not mine." }),
            ),
            (
                "/agent/complete",
                json!({ "job_id": job_id, "outcome": "failed", "error_message": PROXY_REFUSED }),
            ),
            (
                "/agent/message",
                json!({ "job_id": job_id, "content": "Not mine." }),
            ),
        ] {
            let (status, response) = tokio::time::timeout(
                Duration::from_secs(10),
                call_router(
                    &app,
                    Some(&format!("Bearer {token}")),
                    "POST",
                    path.to_string(),
                    Some(body),
                ),
            )
            .await??;
            assert_eq!(
                (status, response["message"].as_str()),
                (StatusCode::UNAUTHORIZED, Some(refusal)),
                "{path}, strict mode {strict_mode}: {response}"
            );
        }
    }
    Ok(())
}

/// A forged call of each kind about `job`: completions that would end it,
/// bill it, refund it, requeue it or settle its goal, and messages that
/// would post a step or a reply, clear its goal or start a team's workers.
fn forged_calls(job: Uuid) -> [(&'static str, JsonValue); 8] {
    [
        (
            "/agent/complete",
            json!({
                "job_id": job,
                "outcome": "succeeded",
                "summary": "Someone else's words.",
                "artifacts": [{
                    "kind": "codex/run-log",
                    "events": [{ "type": "turn.completed", "usage": {
                        "input_tokens": 4000, "cached_input_tokens": 0, "output_tokens": 3000
                    } }],
                }],
                "proxy_metadata": {
                    "provider": "codex-embedded",
                    "conversation": { "defaultThreadId": "someone-elses-thread" },
                },
            }),
        ),
        (
            "/agent/complete",
            json!({
                "job_id": job,
                "outcome": "failed",
                "error_message": PROXY_REFUSED,
                "artifacts": [],
            }),
        ),
        (
            "/agent/complete",
            json!({
                "job_id": job,
                "outcome": "failed",
                "error_message": RATE_LIMITED,
                "artifacts": [],
            }),
        ),
        (
            "/agent/complete",
            json!({ "job_id": job, "outcome": "canceled" }),
        ),
        (
            "/agent/message",
            json!({
                "job_id": job,
                "content": "Ran the tests.",
                "message_type": "status",
                "metadata": { "text": "Ran the tests." },
            }),
        ),
        (
            "/agent/message",
            json!({ "job_id": job, "content": "The door is open." }),
        ),
        (
            "/agent/message",
            json!({
                "job_id": job,
                "content": "Goal cleared.",
                "message_type": "goal_update",
                "metadata": { "operation": "clear" },
            }),
        ),
        (
            "/agent/message",
            json!({
                "job_id": job,
                "content": "Two helpers will check the door.",
                "message_type": "multi_agent_plan",
                "metadata": {
                    "mode": "read_only",
                    "agents": [
                        { "handle": "scout-a", "prompt": "Check the hinges." },
                        { "handle": "scout-b", "prompt": "Check the lock." },
                    ],
                },
            }),
        ),
    ]
}

/// `who` makes every forged call about `job` on `app` with `token`, and each
/// is refused with `expected`.
async fn refused(
    app: &axum::Router,
    who: &str,
    token: &str,
    job: Uuid,
    expected: StatusCode,
) -> anyhow::Result<()> {
    for (path, body) in forged_calls(job) {
        let (status, response) = call_router(
            app,
            Some(&format!("Bearer {token}")),
            "POST",
            path.to_string(),
            Some(body),
        )
        .await?;
        assert_eq!(status, expected, "{who}, {path}: {response}");
    }
    Ok(())
}

/// Everything a call about a job of the space could change, read whole: the
/// space's jobs (a team's workers would be new ones), runs, messages, Home
/// rows, AI usage rows and send queue, its organization's credit ledger and
/// balance, and its conversations' goals and goal wake-ups.
async fn snapshot(harness: &Harness) -> anyhow::Result<JsonValue> {
    sql_one(
        &harness.pool,
        "select jsonb_build_object(
             'jobs', (select coalesce(jsonb_agg(to_jsonb(j) order by j.id), '[]'::jsonb)
                        from agent_jobs j where j.project_id = $1),
             'runs', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb)
                        from runs r where r.project_id = $1),
             'messages', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)
                            from conversation_messages m where m.project_id = $1),
             'home', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
                        from activity_events a where a.project_id = $1),
             'usage', (select coalesce(jsonb_agg(to_jsonb(u) order by u.job_id), '[]'::jsonb)
                         from ai_usage_jobs u where u.project_id = $1),
             'sendQueue', (select coalesce(jsonb_agg(to_jsonb(q) order by q.id), '[]'::jsonb)
                             from conversation_send_queue q where q.project_id = $1),
             'ledger', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb)
                          from org_credit_ledger l where l.org_id = $2),
             'balance', (select to_jsonb(b) from org_credit_balances b where b.org_id = $2),
             'goals', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'conversation', c.id,
                                 'goal', c.metadata -> 'instafyGoal',
                                 'controller', c.metadata -> '_goalController'
                             ) order by c.id), '[]'::jsonb)
                         from conversations c where c.project_id = $1),
             'goalWakeups', (select coalesce(jsonb_agg(to_jsonb(w) order by w.source_job_id),
                                             '[]'::jsonb)
                               from conversation_goal_continuations w
                               join conversations c on c.id = w.conversation_id
                              where c.project_id = $1)
         )",
        &[&harness.space.project_id, &harness.space.org_id],
    )
    .await
}

/// A ready runtime of the space: a computer of `owner`'s, or the space's
/// hosted runtime when there is no owner.
async fn add_runtime(harness: &Harness, owner: Option<Uuid>) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    let mut capabilities = json!({ "agent": true, "origin": true });
    let provider = match owner {
        Some(owner) => {
            crate::runtime::set_self_hosted_access_attestation(
                capabilities.as_object_mut().expect("capabilities"),
                owner,
            );
            "self-hosted"
        }
        None => "instafy-cloud",
    };
    sql(
        &harness.pool,
        "insert into runtimes (
             id, project_id, provider, status, idle_ttl_seconds, last_seen_at, capabilities
         ) values ($1, $2, $3, 'ready', 600, now(), $4)",
        &[
            &id,
            &harness.space.project_id,
            &provider,
            &PgJson(capabilities),
        ],
    )
    .await?;
    Ok(id)
}

/// Binds `job` to an active goal of its conversation, as dispatch binds a
/// person's turn to the goal they set: a goal update from its runtime
/// changes the goal, and the job's end settles it.
async fn bind_goal(harness: &Harness, job: Uuid) -> anyhow::Result<()> {
    let revision = Uuid::new_v4().to_string();
    let owner = harness.space.owner.to_string();
    sql(
        &harness.pool,
        "update conversations
            set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                    'instafyGoal', jsonb_build_object(
                        'id', $2::text, 'objective', 'Open the door', 'status', 'active'),
                    '_goalController', jsonb_build_object(
                        'revision', $3::text, 'ownerUserId', $4::text))
          where id = (select conversation_id from agent_jobs where id = $1)",
        &[&job, &Uuid::new_v4().to_string(), &revision, &owner],
    )
    .await?;
    sql(
        &harness.pool,
        "update agent_jobs
            set payload = jsonb_set(payload, '{metadata,_controllerGoal}', jsonb_build_object(
                    'revision', $2::text, 'ownerUserId', $3::text, 'userTurn', true), true)
          where id = $1",
        &[&job, &revision, &owner],
    )
    .await?;
    Ok(())
}

/// The controller's log lines while it is installed, on the test's own
/// thread, where the agent routes run.
#[derive(Clone, Default)]
struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

impl CapturedLogs {
    fn contents(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("log buffer poisoned")).into_owned()
    }
}

impl std::io::Write for CapturedLogs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("log buffer poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// `job`'s status, leasing runtime and lease attempts.
async fn lease_of(harness: &Harness, job: Uuid) -> anyhow::Result<(String, Option<Uuid>, i32)> {
    let row = harness
        .pool
        .get()
        .await?
        .query_one(
            "select status, leased_by_runtime_id, lease_attempts from agent_jobs where id = $1",
            &[&job],
        )
        .await?;
    Ok((row.get(0), row.get(1), row.get(2)))
}

/// The status of the goal of `job`'s conversation.
async fn goal_status(harness: &Harness, job: Uuid) -> anyhow::Result<Option<String>> {
    sql_one(
        &harness.pool,
        "select c.metadata #>> '{instafyGoal,status}'
           from agent_jobs j join conversations c on c.id = j.conversation_id
          where j.id = $1",
        &[&job],
    )
    .await
}

/// `runtime` leases the next job of the space, which must be `job`.
async fn lease(harness: &Harness, runtime: Uuid, job: Uuid) -> anyhow::Result<()> {
    let leased = harness.lease(runtime).await?;
    anyhow::ensure!(
        leased["id"] == json!(job),
        "{runtime} leased {leased} for {job}"
    );
    Ok(())
}

/// `token`'s runtime posts a step of `job` and then ends it with `outcome`:
/// both are taken.
async fn post_and_end(
    harness: &Harness,
    token: &str,
    job: Uuid,
    outcome: JsonValue,
) -> anyhow::Result<()> {
    let (status, body) = harness
        .call(
            "POST",
            "/agent/message",
            Some(token),
            Some(json!({
                "job_id": job,
                "content": "Checked the door.",
                "message_type": "status",
                "metadata": { "text": "Checked the door." },
            })),
        )
        .await?;
    anyhow::ensure!(status == StatusCode::OK, "step of {job}: {status} {body}");
    let mut completion = json!({ "job_id": job });
    for (key, value) in outcome.as_object().expect("an outcome") {
        completion[key] = value.clone();
    }
    let (status, body) = harness
        .call("POST", "/agent/complete", Some(token), Some(completion))
        .await?;
    anyhow::ensure!(status == StatusCode::OK, "end of {job}: {status} {body}");
    Ok(())
}

/// Only the runtime that leased a job ends it or posts to it, for every job
/// and whatever STRICT_MODE says (docs/Self-Hosted-Runtime-Security.md). A
/// token that names no runtime, which a member with write access mints, is
/// refused outright. Another runtime of the space (the owner's other
/// computer, a teammate's, the space's hosted runtime) is answered as for a
/// job it cannot find, 404, or 403 with STRICT_MODE on. So is every runtime
/// for a job in the queue: one no runtime has leased yet, and one the idle
/// release put back after its lease lapsed, whose runtime still runs and
/// sends its turn's end late (that result is lost: the job runs again). Each
/// refused call writes nothing, while the same calls from the job's own
/// runtime end it, post its steps, settle its goal and send the message
/// waiting behind it. The leasing runtime still ends its job after its lease
/// lapsed while nothing requeued it, as a plan worker refused a renewal for
/// want of a worker slot, and as a draining runtime.
#[tokio::test]
async fn only_the_runtime_that_leased_a_job_ends_it_or_posts_to_it() -> anyhow::Result<()> {
    with_space("leasing-runtime-rule", false, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);
        let runtime_routes = crate::runtime::router().with_state(harness.state.clone());
        let mut strict = harness.state.clone();
        strict.config.strict_mode = true;
        let strict_app = router().with_state(strict);

        let (status, minted) = call_router(
            &runtime_routes,
            Some(&format!("Bearer {}", harness.token(space.member))),
            "POST",
            format!("/projects/{}/runtime/token", space.project_id),
            Some(json!({ "scopes": ["agent.complete", "agent.message"] })),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{minted}");
        assert!(
            minted.get("runtime_id").is_none() && minted.get("runtimeId").is_none(),
            "a token with no runtime: {minted}"
        );
        let no_runtime = minted["token"].as_str().expect("a token").to_string();

        // The owner's turn in the log, bound to the log's goal, with a send
        // of theirs waiting behind it.
        let job = harness.send(space.owner, space.log, person()).await?.id;
        bind_goal(&harness, job).await?;
        let waiting = harness.queue(space.owner, person()).await?;
        let member_computer = add_runtime(&harness, Some(space.member)).await?;
        let hosted = add_runtime(&harness, None).await?;
        // The owner's computer leases the turn.
        let leasing = harness.agent_token(space.runtime).await?;
        let others = [
            (
                "the owner's other computer",
                harness.agent_token(space.other_machine).await?,
            ),
            (
                "a teammate's computer",
                harness.agent_token(member_computer).await?,
            ),
            (
                "the space's hosted runtime",
                harness.agent_token(hosted).await?,
            ),
        ];

        for stage in ["queued", "leased", "requeued"] {
            match stage {
                "leased" => lease(&harness, space.runtime, job).await?,
                "requeued" => {
                    // The lease lapses and a client's idle signal requeues the
                    // job; the owner's computer is private, so it is not
                    // stopped and still runs the turn.
                    sql(
                        &harness.pool,
                        "update agent_jobs set lease_expires_at = now() - interval '1 minute'
                          where id = $1",
                        &[&job],
                    )
                    .await?;
                    let (status, body) = call_router(
                        &runtime_routes,
                        Some(&format!("Bearer {owner}")),
                        "POST",
                        format!("/projects/{}/runtime/activity", space.project_id),
                        Some(json!({ "status": "idle" })),
                    )
                    .await?;
                    assert_eq!(status, StatusCode::OK, "{body}");
                    assert_eq!(body["releasedJobs"], json!(1), "{body}");
                    assert_eq!(
                        sql_one::<String>(
                            &harness.pool,
                            "select status from runtimes where id = $1",
                            &[&space.runtime],
                        )
                        .await?,
                        "ready"
                    );
                }
                _ => {}
            }
            let job_before = lease_of(&harness, job).await?;
            assert_eq!(
                job_before,
                match stage {
                    "queued" => ("queued".to_string(), None, 0),
                    "leased" => ("leased".to_string(), Some(space.runtime), 1),
                    _ => ("queued".to_string(), None, 1),
                },
                "{stage}"
            );
            let before = snapshot(&harness).await?;
            if stage == "requeued" {
                // The turn the computer still runs ends late: its end is
                // refused, and logged with the job's status, which says the
                // job is back in the queue after a lease.
                let logs = CapturedLogs::default();
                let subscriber = tracing::subscriber::set_default(
                    tracing_subscriber::fmt()
                        .with_writer({
                            let logs = logs.clone();
                            move || logs.clone()
                        })
                        .with_ansi(false)
                        .finish(),
                );
                let (status, body) = harness
                    .call(
                        "POST",
                        "/agent/complete",
                        Some(&leasing),
                        Some(json!({
                            "job_id": job,
                            "outcome": "succeeded",
                            "summary": "The door is open.",
                        })),
                    )
                    .await?;
                drop(subscriber);
                assert_eq!(status, StatusCode::NOT_FOUND, "a late end: {body}");
                let logs = logs.contents();
                assert!(
                    logs.contains("agent completion matched no job its runtime holds")
                        && logs.contains("job_status=queued")
                        && logs.contains("lease_attempts=1")
                        && logs.contains("leased_by_a_runtime=false"),
                    "a late end is logged with its job's status: {logs}"
                );
            }
            for (app, strict_mode) in [(&harness.app, false), (&strict_app, true)] {
                refused(
                    app,
                    &format!("no runtime, {stage}, strict {strict_mode}"),
                    &no_runtime,
                    job,
                    StatusCode::UNAUTHORIZED,
                )
                .await?;
                let miss = if strict_mode {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::NOT_FOUND
                };
                for (who, token) in &others {
                    refused(
                        app,
                        &format!("{who}, {stage}, strict {strict_mode}"),
                        token,
                        job,
                        miss,
                    )
                    .await?;
                }
                // A queued job is no runtime's: the computer that is about to
                // lease it, or whose lease of it ended, gets nothing either.
                if stage != "leased" {
                    refused(
                        app,
                        &format!("the owner's computer, {stage}, strict {strict_mode}"),
                        &leasing,
                        job,
                        miss,
                    )
                    .await?;
                }
            }
            assert_eq!(snapshot(&harness).await?, before, "{stage}");
            assert_eq!(lease_of(&harness, job).await?, job_before, "{stage}");
        }
        assert_eq!(goal_status(&harness, job).await?.as_deref(), Some("active"));

        // The owner's computer leases the turn again and its lease lapses,
        // but nothing requeues it: the computer still posts its steps and ends
        // it. Its end settles the goal and sends the waiting message.
        lease(&harness, space.runtime, job).await?;
        sql(
            &harness.pool,
            "update agent_jobs set lease_expires_at = now() - interval '1 minute' where id = $1",
            &[&job],
        )
        .await?;
        post_and_end(
            &harness,
            &leasing,
            job,
            json!({ "outcome": "failed", "error_message": "The door stayed shut." }),
        )
        .await?;
        assert_eq!(
            lease_of(&harness, job).await?,
            ("failed".to_string(), Some(space.runtime), 2)
        );
        assert_eq!(
            goal_status(&harness, job).await?.as_deref(),
            Some("blocked")
        );
        harness.dispatched_run(waiting).await?;
        harness.end_turns().await?;

        // A plan worker whose lease lapsed and whose renewal is refused, as
        // another worker holds the space's one worker slot, still ends.
        let worker = harness
            .send(space.owner, space.other_chat, person())
            .await?
            .id;
        lease(&harness, space.runtime, worker).await?;
        sql(
            &harness.pool,
            "update agent_jobs
                set agent_role = 'worker',
                    payload = jsonb_set(payload, '{metadata,multiAgentPlan}',
                                        '{\"role\": \"worker\"}'::jsonb, true),
                    lease_expires_at = now() - interval '1 minute'
              where id = $1",
            &[&worker],
        )
        .await?;
        sql(
            &harness.pool,
            "insert into project_multi_agent_settings (project_id, max_concurrent_agents)
             values ($1, 1)",
            &[&space.project_id],
        )
        .await?;
        sql(
            &harness.pool,
            "insert into agent_jobs (
                 project_id, status, agent_role, payload, leased_by_runtime_id, leased_at,
                 lease_expires_at, lease_attempts
             ) values (
                 $1, 'leased', 'worker', $3, $2, now(), now() + interval '5 minutes', 1
             )",
            &[
                &space.project_id,
                &space.other_machine,
                &PgJson(json!({ "metadata": { "multiAgentPlan": { "role": "worker" } } })),
            ],
        )
        .await?;
        let (status, body) = harness
            .call(
                "POST",
                "/agent/heartbeat",
                Some(&leasing),
                Some(json!({ "job_id": worker, "extend_seconds": 60 })),
            )
            .await?;
        assert_eq!(status, StatusCode::CONFLICT, "a refused renewal: {body}");
        post_and_end(
            &harness,
            &leasing,
            worker,
            json!({ "outcome": "succeeded", "summary": "The hinges are fine." }),
        )
        .await?;
        assert_eq!(lease_of(&harness, worker).await?.0, "completed");

        // A computer draining before its app quits still ends its turn.
        let last = harness
            .send(space.owner, space.other_chat, person())
            .await?
            .id;
        lease(&harness, space.runtime, last).await?;
        let (status, body) = call_router(
            &runtime_routes,
            Some(&format!("Bearer {owner}")),
            "POST",
            format!(
                "/projects/{}/runtime/{}/drain",
                space.project_id, space.runtime
            ),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], json!("draining"), "{body}");
        post_and_end(
            &harness,
            &leasing,
            last,
            json!({ "outcome": "succeeded", "summary": "The lock is fine." }),
        )
        .await?;
        assert_eq!(lease_of(&harness, last).await?.0, "completed");
        assert_eq!(
            sql_one::<String>(
                &harness.pool,
                "select status from runtimes where id = $1",
                &[&space.runtime],
            )
            .await?,
            "draining"
        );
        Ok(())
    })
    .await
}
