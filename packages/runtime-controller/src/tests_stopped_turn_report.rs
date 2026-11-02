//! A stopped turn's one end report (`POST /agent/stopped`), on the migrated
//! database.
//!
//! The person's Stop cancels a running turn; a step the turn sent before it
//! learned of that had already changed a file. The runtime that ran the turn
//! reports the change once, and the controller records it on the stopped turn
//! and nothing else: the job and its run stay cancelled, no credit moves, and
//! another chat's turn is untouched.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tests_managed_ai_refund::{credit_balance, ledger_rows};
use crate::{agent, AppState};

/// The hosted provider the runtimes run on.
const HOSTED_PROVIDER: &str = "instafy-cloud";

fn test_config(label: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
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

/// An org with one person and one space, holding a few credits, and two
/// machines in the space.
struct Space {
    org_id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    runtime_id: Uuid,
    other_runtime_id: Uuid,
}

/// One running turn of a chat: its conversation, run and job.
struct Turn {
    conversation_id: Uuid,
    run_id: Uuid,
    job_id: Uuid,
}

impl Space {
    async fn seed(pool: &PgPool, label: &str) -> anyhow::Result<Self> {
        let space = Self {
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            other_runtime_id: Uuid::new_v4(),
        };
        ensure_test_user(pool, &space.owner_user_id).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&space.org_id, &format!("{label}-{}", space.org_id), &label],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&space.org_id, &space.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, $3, $4, 'customer', 'active')",
                &[
                    &space.project_id,
                    &space.org_id,
                    &label,
                    &space.owner_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                 values ($1, $2, 20, 'test_seed', '{}'::jsonb)",
                &[&space.org_id, &space.project_id],
            )
            .await?;
        for runtime_id in [space.runtime_id, space.other_runtime_id] {
            connection
                .execute(
                    "insert into runtimes (
                         id, project_id, provider, status, endpoint_url, task_ref,
                         idle_ttl_seconds, last_seen_at, capabilities
                     ) values ($1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), $5)",
                    &[
                        &runtime_id,
                        &space.project_id,
                        &HOSTED_PROVIDER,
                        &format!("stopped-turn-report-{runtime_id}"),
                        &PgJson(json!({ "agent": true, "origin": true })),
                    ],
                )
                .await?;
        }
        Ok(space)
    }

    /// A turn of a new chat, running on `runtime_id`.
    async fn running_turn(&self, pool: &PgPool, runtime_id: &Uuid) -> anyhow::Result<Turn> {
        let turn = Turn {
            conversation_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
        };
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, visibility)
                 values ($1, $2, $3, 'private')",
                &[&turn.conversation_id, &self.project_id, &self.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status, metadata)
                 values ($1, $2, $3, 'prompt', 'in_progress', $4)",
                &[
                    &turn.run_id,
                    &self.project_id,
                    &turn.conversation_id,
                    &PgJson(json!({ "initiatingUserId": self.owner_user_id })),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into agent_jobs (
                     id, project_id, conversation_id, run_id, status, payload,
                     lease_attempts, leased_at, lease_expires_at, leased_by_runtime_id
                 ) values (
                     $1, $2, $3, $4, 'leased', $5, 1, now(), now() + interval '2 minutes', $6
                 )",
                &[
                    &turn.job_id,
                    &self.project_id,
                    &turn.conversation_id,
                    &turn.run_id,
                    &PgJson(json!({
                        "user_id": self.owner_user_id,
                        "conversation_id": turn.conversation_id,
                        "prompt_text": "keep going",
                        "metadata": { "agent": { "handle": "octo" } },
                    })),
                    runtime_id,
                ],
            )
            .await?;
        Ok(turn)
    }

    /// The person's Stop of `turn`, as `/conversations/:id/stop` makes it.
    async fn stop(&self, state: &AppState, turn: &Turn) -> anyhow::Result<()> {
        let mut connection = state.pool.get().await?;
        let transaction = connection.transaction().await?;
        let mut notice = crate::conversations::build_interruption_notice(
            "Stopped",
            &[turn.job_id],
            &[turn.run_id],
        );
        notice.content = "Stopped this run.".to_string();
        notice.metadata["details"]["stopRequested"] = json!(true);
        notice.metadata["details"]["actorUserId"] = json!(self.owner_user_id);
        crate::conversations::cancel_jobs_with_notice(
            &state.config,
            &transaction,
            &self.project_id,
            &turn.conversation_id,
            None,
            &[(turn.job_id, Some(turn.run_id))],
            "Stopped",
            Some(notice),
        )
        .await
        .map_err(|error| controller_error("stop the turn", error))?;
        transaction.commit().await?;
        Ok(())
    }

    /// The end report of `job_id`'s turn, posted as `runtime_id`.
    async fn report(
        &self,
        state: &AppState,
        runtime_id: &Uuid,
        job_id: &Uuid,
    ) -> anyhow::Result<StatusCode> {
        self.report_with(state, runtime_id, job_id, &[PAGE], &[])
            .await
    }

    /// The end report of `job_id`'s turn naming `paths` (by their place in
    /// the turn's folder, as the runtime names them), with the turn's save
    /// among `more_artifacts` when it ran one.
    async fn report_with(
        &self,
        state: &AppState,
        runtime_id: &Uuid,
        job_id: &Uuid,
        paths: &[&str],
        more_artifacts: &[JsonValue],
    ) -> anyhow::Result<StatusCode> {
        let body = json!({
            "job_id": job_id.to_string(),
            "content": format!("Applied file changes: {}", paths.join(", ")),
            "message_type": "file_change",
            "metadata": {
                "kind": "codex_file_change",
                "itemId": "stopped-turn-files",
                "eventType": "item.completed",
                "status": "completed",
                "paths": paths,
                "activity": edit_label(paths.len()),
            },
            "artifacts": std::iter::once(json!({
                "kind": "apply/files",
                "files": paths.iter().map(|path| {
                    let relative = path.trim_start_matches(WORKSPACE);
                    json!({
                        "path": relative,
                        "workspacePath": relative,
                        "change": { "type": "changed" },
                        "changeType": "changed",
                        "source": "workspace",
                    })
                }).collect::<Vec<_>>(),
                "metadata": { "provider": "codex-embedded" },
            }))
            .chain(more_artifacts.iter().cloned())
            .collect::<Vec<_>>(),
        });
        self.post(state, runtime_id, "/agent/stopped", body).await
    }

    /// A step `job_id`'s runtime streams while its turn runs: an edit of
    /// `paths`, as item `item_id`.
    async fn streamed_edit(
        &self,
        state: &AppState,
        runtime_id: &Uuid,
        job_id: &Uuid,
        item_id: &str,
        paths: &[&str],
    ) -> anyhow::Result<StatusCode> {
        let body = json!({
            "job_id": job_id.to_string(),
            "content": format!("Applied file changes: {}", paths.join(", ")),
            "message_type": "file_change",
            "metadata": {
                "kind": "codex_file_change",
                "itemId": item_id,
                "eventType": "item.completed",
                "status": "completed",
                "paths": paths,
                "activity": edit_label(paths.len()),
            },
        });
        self.post(state, runtime_id, "/agent/message", body).await
    }

    async fn post(
        &self,
        state: &AppState,
        runtime_id: &Uuid,
        uri: &str,
        body: JsonValue,
    ) -> anyhow::Result<StatusCode> {
        let token =
            crate::auth::issue_agent_token(&state.config, &self.project_id, runtime_id, None, None)
                .map_err(|error| controller_error("issue agent token", error))?
                .token;
        let response = agent::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        let status = response.status();
        let _ = to_bytes(response.into_body(), usize::MAX).await?;
        Ok(status)
    }
}

/// The folder the turns ran in, as the runtime names a file in it.
const WORKSPACE: &str = "/workspace/space/";
/// The page the stopped turns edited.
const PAGE: &str = "/workspace/space/sites/porto/app.js";
/// A page a command of the turn wrote, which no edit step named.
const ROUTE: &str = "/workspace/space/sites/porto/route.html";

/// The runtime's label of an edit of `files` files.
fn edit_label(files: usize) -> JsonValue {
    json!({
        "v": 1, "key": "builtin/edit", "role": "content", "live": "Editing files",
        "done": { "one": "edited a file", "other": "edited {n} files", "some": "edited files" },
        "count": files, "also": [],
    })
}

/// The messages of a chat that its job `job_id`'s runtime reported.
async fn job_steps(
    pool: &PgPool,
    conversation_id: &Uuid,
    job_id: &Uuid,
) -> anyhow::Result<Vec<(String, JsonValue, Option<Uuid>)>> {
    Ok(pool
        .get()
        .await?
        .query(
            "select content, metadata, run_id from conversation_messages
             where conversation_id = $1 and metadata->>'jobId' = $2
             order by created_at",
            &[conversation_id, &job_id.to_string()],
        )
        .await?
        .iter()
        .map(|row| {
            (
                row.get("content"),
                row.get::<_, PgJson<JsonValue>>("metadata").0,
                row.get("run_id"),
            )
        })
        .collect())
}

async fn job_state(pool: &PgPool, job_id: &Uuid) -> anyhow::Result<(String, JsonValue)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select status, artifacts from agent_jobs where id = $1",
            &[job_id],
        )
        .await?;
    Ok((row.get(0), row.get::<_, PgJson<JsonValue>>(1).0))
}

async fn run_status(pool: &PgPool, run_id: &Uuid) -> anyhow::Result<String> {
    Ok(pool
        .get()
        .await?
        .query_one("select status from runs where id = $1", &[run_id])
        .await?
        .get(0))
}

#[tokio::test]
async fn a_stopped_turn_reports_its_edit_once_and_its_charge_stays_the_reserve(
) -> anyhow::Result<()> {
    let label = "stopped-turn-report";
    let pool = require_origin_test_pool(label).await?;
    let space = Space::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let owner = space.owner_user_id;
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async move {
        let pool = body_pool;
        let state = build_test_state(pool.clone(), test_config(label));
        let turn = space.running_turn(&pool, &space.runtime_id).await?;
        // Another chat's turn, running on the same machine.
        let other = space.running_turn(&pool, &space.runtime_id).await?;
        // The send's reserve, as dispatch takes it.
        {
            let mut connection = pool.get().await?;
            let transaction = connection.transaction().await?;
            crate::credits::process_credit_burn(
                &transaction,
                &space.project_id,
                &space.org_id,
                None,
                1,
                "managed_ai_prompt",
                Some(&format!("managed-ai-prompt:{}", turn.job_id)),
                &mut json!({ "source": "managed_ai" }),
            )
            .await
            .map_err(|error| controller_error("reserve the send's credit", error))?;
            transaction.commit().await?;
        }
        space.stop(&state, &turn).await?;
        let ledger_after_stop = ledger_rows(&pool, &space.project_id).await?;
        let balance_after_stop = credit_balance(&pool, &space.org_id).await?;

        // Not from another machine of the space.
        assert_eq!(
            space
                .report(&state, &space.other_runtime_id, &turn.job_id)
                .await?,
            StatusCode::CONFLICT
        );
        // Not for a turn still running: another chat's is untouched.
        assert_eq!(
            space
                .report(&state, &space.runtime_id, &other.job_id)
                .await?,
            StatusCode::CONFLICT
        );
        // From the machine that ran the stopped turn: recorded, once.
        assert_eq!(
            space
                .report(&state, &space.runtime_id, &turn.job_id)
                .await?,
            StatusCode::OK
        );
        assert_eq!(
            space
                .report(&state, &space.runtime_id, &turn.job_id)
                .await?,
            StatusCode::CONFLICT
        );

        // One step in the stopped turn's thread: the edit, with its files.
        let steps = job_steps(&pool, &turn.conversation_id, &turn.job_id).await?;
        assert_eq!(steps.len(), 1, "{steps:?}");
        let (content, metadata, run_id) = &steps[0];
        assert_eq!(content, &format!("Applied file changes: {PAGE}"));
        assert_eq!(*run_id, Some(turn.run_id));
        assert_eq!(metadata["source"], "agent");
        assert_eq!(metadata["kind"], "update");
        assert_eq!(metadata["messageType"], "file_change");
        assert_eq!(metadata["jobId"], json!(turn.job_id.to_string()));
        assert_eq!(metadata["outcome"], "canceled");
        assert_eq!(metadata["details"]["status"], "completed");
        // The edit's own label, which the turn's line counts.
        assert_eq!(metadata["activity"]["key"], "builtin/edit");
        assert_eq!(metadata["details"]["paths"], json!([PAGE]));
        assert_eq!(metadata["details"]["itemId"], "stopped-turn-files");
        assert_eq!(metadata["artifacts"][0]["kind"], "apply/files");
        assert_eq!(
            metadata["artifacts"][0]["files"][0]["workspacePath"],
            "sites/porto/app.js"
        );

        // The turn stays stopped, its job holds the report, and no credit moved:
        // the turn's charge is its reserve.
        let (status, artifacts) = job_state(&pool, &turn.job_id).await?;
        assert_eq!(status, "canceled");
        assert_eq!(artifacts[0]["kind"], "apply/files");
        assert_eq!(artifacts[1]["kind"], "stopped-turn/reported");
        assert_eq!(run_status(&pool, &turn.run_id).await?, "canceled");
        assert_eq!(
            ledger_rows(&pool, &space.project_id).await?,
            ledger_after_stop
        );
        assert_eq!(
            credit_balance(&pool, &space.org_id).await?,
            balance_after_stop
        );

        // Another chat's running turn: still running, nothing recorded.
        assert_eq!(
            job_state(&pool, &other.job_id).await?,
            ("leased".to_string(), json!([]))
        );
        assert_eq!(run_status(&pool, &other.run_id).await?, "in_progress");
        assert!(job_steps(&pool, &other.conversation_id, &other.job_id)
            .await?
            .is_empty());

        // Later turns of the chat (Octo's, as its next job loads them) read
        // what the stopped turn left.
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let history = crate::agent::load_conversation_history_for_agent(
            &transaction,
            &turn.conversation_id,
            None,
            Some("octo"),
            None,
            50,
        )
        .await
        .map_err(|error| controller_error("load the chat's history", error))?;
        transaction.commit().await?;
        assert!(
            history.iter().any(|entry| {
                entry["metadata"]["jobId"] == json!(turn.job_id.to_string())
                    && entry["metadata"]["messageType"] == "file_change"
            }),
            "{history:?}"
        );

        // A report long after the Stop is not taken.
        let late = space.running_turn(&pool, &space.runtime_id).await?;
        space.stop(&state, &late).await?;
        pool.get()
            .await?
            .execute(
                "update agent_jobs set completed_at = now() - interval '5 minutes' where id = $1",
                &[&late.job_id],
            )
            .await?;
        assert_eq!(
            space
                .report(&state, &space.runtime_id, &late.job_id)
                .await?,
            StatusCode::CONFLICT
        );
        Ok(())
    })
    .await;
    let cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = $1", &[&owner])
        .await;
    result.and(cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

/// Runs `body` on a seeded space, then removes what it made.
async fn on_a_space<F, Fut>(label: &'static str, body: F) -> anyhow::Result<()>
where
    F: FnOnce(PgPool, AppState, Space) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let pool = require_origin_test_pool(label).await?;
    let space = Space::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let owner = space.owner_user_id;
    let state = build_test_state(pool.clone(), test_config(label));
    let result = with_shared_db_fixture(fixture, body(pool.clone(), state, space)).await;
    let cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = $1", &[&owner])
        .await;
    result.and(cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

/// The usual Stop: the turn's edit was recorded as its own step before the
/// press. The report does not name it again: it restates that step, the same
/// item, with the turn's files, so the chat still counts one edited file and
/// lists one row for it. A file only a command wrote, which no edit step
/// named, is what the report names.
#[tokio::test]
async fn a_stopped_turns_report_names_only_what_its_chat_does_not_show_yet() -> anyhow::Result<()> {
    on_a_space(
        "stopped-turn-report-shown",
        |pool, state, space| async move {
            // The edit's step reached the chat while the turn ran.
            let turn = space.running_turn(&pool, &space.runtime_id).await?;
            assert_eq!(
                space
                    .streamed_edit(
                        &state,
                        &space.runtime_id,
                        &turn.job_id,
                        "call_edit",
                        &[PAGE]
                    )
                    .await?,
                StatusCode::OK
            );
            space.stop(&state, &turn).await?;
            assert_eq!(
                space
                    .report(&state, &space.runtime_id, &turn.job_id)
                    .await?,
                StatusCode::OK
            );
            let steps = job_steps(&pool, &turn.conversation_id, &turn.job_id).await?;
            assert_eq!(steps.len(), 2, "{steps:?}");
            let (streamed, restated) = (&steps[0], &steps[1]);
            assert_eq!(restated.0, streamed.0);
            assert_eq!(restated.1["details"]["itemId"], "call_edit");
            assert_eq!(restated.1["details"]["paths"], json!([PAGE]));
            assert_eq!(restated.1["activity"]["key"], "builtin/edit");
            assert_eq!(restated.1["activity"]["count"], 1);
            assert_eq!(restated.1["outcome"], "canceled");
            assert_eq!(restated.1["artifacts"][0]["kind"], "apply/files");
            assert_eq!(
                restated.1["artifacts"][0]["files"][0]["workspacePath"],
                "sites/porto/app.js"
            );
            assert!(streamed.1.get("artifacts").is_none());

            // A turn that edited the page, then wrote another with a command: the
            // report names only that one, as one edited file.
            let turn = space.running_turn(&pool, &space.runtime_id).await?;
            space
                .streamed_edit(
                    &state,
                    &space.runtime_id,
                    &turn.job_id,
                    "call_edit",
                    &[PAGE],
                )
                .await?;
            space.stop(&state, &turn).await?;
            assert_eq!(
                space
                    .report_with(&state, &space.runtime_id, &turn.job_id, &[PAGE, ROUTE], &[])
                    .await?,
                StatusCode::OK
            );
            let steps = job_steps(&pool, &turn.conversation_id, &turn.job_id).await?;
            assert_eq!(steps.len(), 2, "{steps:?}");
            let (content, metadata, _) = &steps[1];
            assert_eq!(content, &format!("Applied file changes: {ROUTE}"));
            assert_eq!(metadata["details"]["itemId"], "stopped-turn-files");
            assert_eq!(metadata["details"]["paths"], json!([ROUTE]));
            assert_eq!(metadata["activity"]["count"], 1);
            assert_eq!(
                metadata["artifacts"][0]["files"].as_array().map(Vec::len),
                Some(2)
            );
            Ok(())
        },
    )
    .await
}

/// A Stop that reached the turn while it saved: its report carries the
/// turn's own save, which the chat's files then read as that save left them.
/// Nothing else rides along: a report with the turn's usage is refused.
#[tokio::test]
async fn a_turn_stopped_while_it_saved_reports_its_save_and_never_its_usage() -> anyhow::Result<()>
{
    on_a_space("stopped-turn-report-saved", |pool, state, space| async move {
        let turn = space.running_turn(&pool, &space.runtime_id).await?;
        space
            .streamed_edit(&state, &space.runtime_id, &turn.job_id, "call_edit", &[PAGE])
            .await?;
        space.stop(&state, &turn).await?;
        let usage = json!({ "kind": "ai/task-usage", "usage": { "inputTokens": 42 } });
        assert_eq!(
            space
                .report_with(&state, &space.runtime_id, &turn.job_id, &[PAGE], &[usage])
                .await?,
            StatusCode::BAD_REQUEST
        );
        let save = json!({
            "kind": "origin/apply",
            "metadata": { "gitSyncStatus": "synced", "gitRev": "abc1234", "gitBaseRev": "def5678" },
        });
        assert_eq!(
            space
                .report_with(&state, &space.runtime_id, &turn.job_id, &[PAGE], &[save.clone()])
                .await?,
            StatusCode::OK
        );
        let steps = job_steps(&pool, &turn.conversation_id, &turn.job_id).await?;
        assert_eq!(steps.len(), 2, "{steps:?}");
        assert_eq!(steps[1].1["artifacts"][1], save);
        Ok(())
    })
    .await
}

/// A turn a short rate limit put back in the queue keeps what its first
/// attempt left among its job's artifacts. Stopped on its next attempt, its
/// report is taken, and only once.
#[tokio::test]
async fn a_turn_retried_after_a_rate_limit_is_reported_once_when_stopped() -> anyhow::Result<()> {
    on_a_space(
        "stopped-turn-report-retried",
        |pool, state, space| async move {
            let turn = space.running_turn(&pool, &space.runtime_id).await?;
            // The failed first attempt's usage, as its completion stored it.
            pool.get()
                .await?
                .execute(
                    "update agent_jobs
                    set artifacts = '[{\"kind\": \"ai/task-usage\", \"usage\": {}}]'::jsonb
                  where id = $1",
                    &[&turn.job_id],
                )
                .await?;
            space.stop(&state, &turn).await?;
            assert_eq!(
                space
                    .report(&state, &space.runtime_id, &turn.job_id)
                    .await?,
                StatusCode::OK
            );
            assert_eq!(
                space
                    .report(&state, &space.runtime_id, &turn.job_id)
                    .await?,
                StatusCode::CONFLICT
            );
            let (_, artifacts) = job_state(&pool, &turn.job_id).await?;
            assert_eq!(artifacts[0]["kind"], "ai/task-usage");
            assert_eq!(
                job_steps(&pool, &turn.conversation_id, &turn.job_id)
                    .await?
                    .len(),
                1
            );
            Ok(())
        },
    )
    .await
}
