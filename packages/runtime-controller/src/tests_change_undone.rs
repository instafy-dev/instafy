//! The line an Undo leaves in a chat's history (`change_undone.rs`), on the
//! migrated database: one hidden line, in the controller's words, that the
//! next turn's history carries, and no turn, credit, message of the day or
//! new last line for the chat.

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
                            "files": [{
                                "path": "sites/page/app.js",
                                "workspacePath": "sites/page/app.js",
                                "change": { "type": "changed" },
                            }],
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
                    .body(Body::empty())?,
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
            .undone(&state, &chat.owner_user_id, &chat.changed_message_id)
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
        assert!(
            body["runId"].is_null() && body["promptId"].is_null(),
            "{body}"
        );
        let line_id = body["id"].as_str().expect("line id").to_string();

        // Once per change.
        let (status, again) = chat
            .undone(&state, &chat.owner_user_id, &chat.changed_message_id)
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
            .undone(&state, &chat.owner_user_id, &chat.plain_message_id)
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let stranger = Uuid::new_v4();
        ensure_test_user(&pool, &stranger).await?;
        let (status, _) = chat
            .undone(&state, &stranger, &chat.changed_message_id)
            .await?;
        assert!(
            matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
            "{status}"
        );
        Ok(())
    })
    .await
}
