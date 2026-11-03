//! The line an Undo leaves in a chat's history (`change_undone.rs`), on the
//! migrated database: one hidden line, in the controller's words, that the
//! next turn's history carries, and no turn, credit, message of the day or
//! new last line for the chat. It names the files the Undo left as they were,
//! and quotes the person's request, never a hand-back's words.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::PgPool;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::AppState;

const REQUEST: &str = "Add a short \"Before you go\" section to that page.";
const APP: &str = "sites/page/app.js";
/// A file the turn's save never took (a secret file), which Undo leaves.
const SECRET: &str = "sites/page/.env.local";

struct Chat {
    org_id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    conversation_id: Uuid,
    run_id: Uuid,
    /// The reply that lists the files the turn changed.
    changed_message_id: Uuid,
    /// A reply that changed nothing.
    plain_message_id: Uuid,
}

impl Chat {
    async fn seed(pool: &PgPool, label: &str) -> anyhow::Result<Self> {
        let chat = Self {
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            changed_message_id: Uuid::new_v4(),
            plain_message_id: Uuid::new_v4(),
        };
        ensure_test_user(pool, &chat.owner_user_id).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&chat.org_id, &format!("{label}-{}", chat.org_id), &label],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&chat.org_id, &chat.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, $3, $4, 'customer', 'active')",
                &[&chat.project_id, &chat.org_id, &label, &chat.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, visibility, last_message_preview)
                 values ($1, $2, $3, 'private', 'Added the section.')",
                &[&chat.conversation_id, &chat.project_id, &chat.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $2, $3, 'prompt', 'canceled')",
                &[&chat.run_id, &chat.project_id, &chat.conversation_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata, created_by, created_at
                 ) values ($1, $2, $3, $4, 'user', $5, '{}'::jsonb, $6, now() - interval '3 minutes')",
                &[
                    &Uuid::new_v4(),
                    &chat.conversation_id,
                    &chat.project_id,
                    &chat.run_id,
                    &REQUEST,
                    &chat.owner_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata, created_at
                 ) values ($1, $2, $3, $4, 'assistant', 'Applied file changes: sites/page/app.js',
                           $5, now() - interval '2 minutes')",
                &[
                    &chat.changed_message_id,
                    &chat.conversation_id,
                    &chat.project_id,
                    &chat.run_id,
                    &PgJson(json!({
                        "source": "agent",
                        "messageType": "file_change",
                        "artifacts": [{
                            "kind": "apply/files",
                            "files": [
                                {
                                    "path": APP,
                                    "workspacePath": APP,
                                    "change": { "type": "changed" },
                                },
                                {
                                    "path": SECRET,
                                    "workspacePath": SECRET,
                                    "change": { "type": "changed" },
                                },
                            ],
                        }],
                    })),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata, created_at
                 ) values ($1, $2, $3, $4, 'assistant', 'Stopped this run.', '{}'::jsonb,
                           now() - interval '1 minute')",
                &[
                    &chat.plain_message_id,
                    &chat.conversation_id,
                    &chat.project_id,
                    &chat.run_id,
                ],
            )
            .await?;
        Ok(chat)
    }

    async fn undone(
        &self,
        state: &AppState,
        user_id: &Uuid,
        message_id: &Uuid,
        paths: &[&str],
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let token = crate::auth::issue_controller_token(&state.config, user_id)
            .map_err(|(status, error)| anyhow::anyhow!("token: {status} {}", error.0.message))?
            .token;
        let response = crate::change_undone::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/projects/{}/messages/{message_id}/undone",
                        self.project_id
                    ))
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "paths": paths }).to_string()))?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null),
        ))
    }
}

async fn count(pool: &PgPool, query: &str, id: &Uuid) -> anyhow::Result<i64> {
    Ok(pool.get().await?.query_one(query, &[id]).await?.get(0))
}

#[tokio::test]
async fn an_undo_leaves_one_hidden_line_the_next_turn_reads_and_nothing_else() -> anyhow::Result<()>
{
    let label = "change-undone-line";
    let pool = require_origin_test_pool(label).await?;
    let chat = Chat::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![chat.org_id],
        projects: vec![chat.project_id],
    };
    let body_pool = pool.clone();
    with_shared_db_fixture(fixture, async move {
        let pool = body_pool;
        let state = build_test_state(
            pool.clone(),
            build_app_config(test_origin_private_key(), test_origin_public_key(), label),
        );
        let prompts = "select count(*) from prompts where project_id = $1";
        let jobs = "select count(*) from agent_jobs where project_id = $1";
        let ledger = "select count(*) from org_credit_ledger where project_id = $1";
        let before = (
            count(&pool, prompts, &chat.project_id).await?,
            count(&pool, jobs, &chat.project_id).await?,
            count(&pool, ledger, &chat.project_id).await?,
        );

        let (status, body) = chat
            .undone(
                &state,
                &chat.owner_user_id,
                &chat.changed_message_id,
                &[APP, SECRET],
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["role"], "assistant");
        assert_eq!(
            body["content"],
            format!("The person undid the change from “{REQUEST}”")
        );
        assert_eq!(body["metadata"]["presentation"]["hidden"], true, "{body}");
        assert_eq!(body["metadata"]["kind"], "change_undone");
        assert_eq!(
            body["metadata"]["undoneMessageId"],
            chat.changed_message_id.to_string()
        );
        assert_eq!(body["metadata"]["undoneRunId"], chat.run_id.to_string());
        assert_eq!(body["metadata"]["undonePaths"], json!([SECRET, APP]));
        assert!(
            body["runId"].is_null() && body["promptId"].is_null(),
            "{body}"
        );
        let line_id = body["id"].as_str().expect("line id").to_string();

        // Once per change.
        let (status, again) = chat
            .undone(
                &state,
                &chat.owner_user_id,
                &chat.changed_message_id,
                &[APP],
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["id"], line_id);

        // No turn, no credit, no message of the day, and not the chat's last
        // line.
        let after = (
            count(&pool, prompts, &chat.project_id).await?,
            count(&pool, jobs, &chat.project_id).await?,
            count(&pool, ledger, &chat.project_id).await?,
        );
        assert_eq!(after, before);
        let preview: Option<String> = pool
            .get()
            .await?
            .query_one(
                "select last_message_preview from conversations where id = $1",
                &[&chat.conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(preview.as_deref(), Some("Added the section."));

        // The next turn's history carries it, after the change it undid.
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let history = crate::agent::load_conversation_history_for_agent(
            &transaction,
            &chat.conversation_id,
            None,
            None,
            None,
            50,
        )
        .await
        .map_err(|(status, error)| anyhow::anyhow!("history: {status} {}", error.0.message))?;
        transaction.rollback().await?;
        let last = history.last().expect("history");
        assert_eq!(last["role"], "assistant");
        assert_eq!(
            last["content"],
            format!("The person undid the change from “{REQUEST}”")
        );

        // Only a change can be undone, and only by someone who may write the
        // space.
        let (status, _) = chat
            .undone(&state, &chat.owner_user_id, &chat.plain_message_id, &[APP])
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let stranger = Uuid::new_v4();
        ensure_test_user(&pool, &stranger).await?;
        let (status, _) = chat
            .undone(&state, &stranger, &chat.changed_message_id, &[APP])
            .await?;
        assert!(
            matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
            "{status}"
        );
        Ok(())
    })
    .await
}

/// The line for an Undo that left some of the change as it was names the
/// files it undid, and Studio reads only those as undone: a file the turn's
/// save never took keeps its state.
#[tokio::test]
async fn an_undo_that_left_part_of_a_change_names_the_files_it_undid() -> anyhow::Result<()> {
    let label = "change-undone-part";
    let pool = require_origin_test_pool(label).await?;
    let chat = Chat::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![chat.org_id],
        projects: vec![chat.project_id],
    };
    let body_pool = pool.clone();
    with_shared_db_fixture(fixture, async move {
        let pool = body_pool;
        let state = build_test_state(
            pool.clone(),
            build_app_config(test_origin_private_key(), test_origin_public_key(), label),
        );

        let (status, body) = chat
            .undone(
                &state,
                &chat.owner_user_id,
                &chat.changed_message_id,
                &[APP],
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["content"],
            format!("The person undid the change from “{REQUEST}” in {APP} only")
        );
        assert_eq!(body["metadata"]["undonePaths"], json!([APP]));
        let first = body["id"].clone();

        // The same files again: the line already there.
        let (status, again) = chat
            .undone(
                &state,
                &chat.owner_user_id,
                &chat.changed_message_id,
                &[APP],
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["id"], first);

        // Another file of the change, undone later: a line for that one.
        let (status, rest) = chat
            .undone(
                &state,
                &chat.owner_user_id,
                &chat.changed_message_id,
                &[APP, SECRET],
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{rest}");
        assert_ne!(rest["id"], first);
        assert_eq!(rest["metadata"]["undonePaths"], json!([SECRET]));

        // Never a file the change did not touch, and never none.
        for paths in [&["sites/other/app.js"][..], &[][..]] {
            let (status, refused) = chat
                .undone(&state, &chat.owner_user_id, &chat.changed_message_id, paths)
                .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{paths:?} {refused}");
        }
        let lines: i64 = pool
            .get()
            .await?
            .query_one(
                "select count(*) from conversation_messages
                  where conversation_id = $1 and metadata->>'kind' = 'change_undone'",
                &[&chat.conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(lines, 2);
        Ok(())
    })
    .await
}

/// A page made by a hand-back (Octo carrying on a browser turn, in the
/// person's role with Octo's words) is undone in the person's words: the line
/// quotes the message whose turn asked for that browser turn.
#[tokio::test]
async fn the_line_quotes_the_persons_request_never_a_hand_backs_words() -> anyhow::Result<()> {
    let label = "change-undone-hand-back";
    let pool = require_origin_test_pool(label).await?;
    let chat = Chat::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![chat.org_id],
        projects: vec![chat.project_id],
    };
    let body_pool = pool.clone();
    with_shared_db_fixture(fixture, async move {
        let pool = body_pool;
        let state = build_test_state(
            pool.clone(),
            build_app_config(test_origin_private_key(), test_origin_public_key(), label),
        );
        let asked = "Put the hours and the metro route on a small page I can share.";
        let (card_run, card_job, browser_job, hand_back_run, page_message) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let connection = pool.get().await?;
        for run in [card_run, hand_back_run] {
            connection
                .execute(
                    "insert into runs (id, project_id, conversation_id, run_type, status)
                     values ($1, $2, $3, 'prompt', 'success')",
                    &[&run, &chat.project_id, &chat.conversation_id],
                )
                .await?;
        }
        connection
            .execute(
                "insert into agent_jobs (id, project_id, conversation_id, run_id, status, payload)
                 values ($1, $2, $3, $4, 'completed', '{}'::jsonb)",
                &[&card_job, &chat.project_id, &chat.conversation_id, &card_run],
            )
            .await?;
        // The person's message, whose turn asked for the browser.
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata, created_by, created_at
                 ) values ($1, $2, $3, $4, 'user', $5, '{}'::jsonb, $6, now() - interval '50 seconds')",
                &[
                    &Uuid::new_v4(),
                    &chat.conversation_id,
                    &chat.project_id,
                    &card_run,
                    &asked,
                    &chat.owner_user_id,
                ],
            )
            .await?;
        // Octo's hand-back of that browser turn, sent in the person's name.
        let hand_back = json!({
            "version": 1,
            "browserJobId": browser_job.to_string(),
            "cardJobId": card_job.to_string(),
            "findingCount": 0,
        });
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata, created_by, created_at
                 ) values ($1, $2, $3, $4, 'user', $5, $6, $7, now() - interval '40 seconds')",
                &[
                    &Uuid::new_v4(),
                    &chat.conversation_id,
                    &chat.project_id,
                    &hand_back_run,
                    &crate::browser_hand_back::HAND_BACK_PROMPT,
                    &PgJson(json!({
                        "browserHandBack": hand_back,
                        "prompt_metadata": {
                            "displayContent": "Octo continued in the chat",
                            "browserHandBack": hand_back,
                        },
                    })),
                    &chat.owner_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_messages (
                     id, conversation_id, project_id, run_id, role, content, metadata, created_at
                 ) values ($1, $2, $3, $4, 'assistant', 'Applied file changes: sites/page/app.js',
                           $5, now() - interval '30 seconds')",
                &[
                    &page_message,
                    &chat.conversation_id,
                    &chat.project_id,
                    &hand_back_run,
                    &PgJson(json!({
                        "artifacts": [{
                            "kind": "apply/files",
                            "files": [{ "path": APP, "change": { "type": "created" } }],
                        }],
                    })),
                ],
            )
            .await?;

        let (status, body) = chat
            .undone(&state, &chat.owner_user_id, &page_message, &[APP])
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["content"],
            format!("The person undid the change from “{asked}”")
        );
        Ok(())
    })
    .await
}
