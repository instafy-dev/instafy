//! What an Undo leaves in a chat's history.
//!
//! Undo in Studio takes a turn's change back without a turn of Octo's: a
//! saved change gets a new saved version that undoes it, and a change no save
//! took goes back in the folder. Neither is a message, so the history the
//! next turn and its routing step read never said so, and "keep going" carried
//! on the change the person had just undone.
//!
//! Studio now reports an Undo that worked here, and the controller records one
//! line in the chat's history, in its own words: "The person undid the change
//! from “…”", quoting the request that made the change. The line is kept out
//! of the transcript (`presentation.hidden`, as `activity::is_kept_out_of_
//! transcript` and Studio read it): no bubble and no notification, and it is
//! no turn, so it costs no credit and none of the day's messages. Nor does it
//! become the chat's last line on Home. Every later turn and routing step
//! read it in the chat's history (runtime-agent `conversation_context.rs`),
//! and Studio reads it to show that change as undone, with no Undo and no
//! Continue, after a reload too.

use std::str::FromStr;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::conversations::{
    ensure_conversation_access, ensure_not_internal_conversation, load_conversation_record,
    map_conversation_message_row, message_row_to_payload, publish_conversation_message_event,
    ConversationMessagePayload, ConversationMessageRow,
};
use crate::{
    bad_request, ensure_project_write_access, internal_error, not_found, ApiError, AppState,
};

/// The `kind` of the line an Undo leaves.
pub(crate) const CHANGE_UNDONE_KIND: &str = "change_undone";
/// The longest quote of the person's request the line carries.
const REQUEST_QUOTE_MAX_CHARS: usize = 140;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/:project_id/messages/:message_id/undone",
        post(record_change_undone),
    )
}

/// The line, quoting the request that made the change.
pub(crate) fn change_undone_line(request: &str) -> String {
    let words = request.split_whitespace().collect::<Vec<_>>().join(" ");
    let quote = if words.chars().count() > REQUEST_QUOTE_MAX_CHARS {
        let cut: String = words.chars().take(REQUEST_QUOTE_MAX_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        words
    };
    format!("The person undid the change from “{quote}”")
}

/// Whether a message lists files its turn changed (an `apply/files` artifact
/// with at least one file that is not only read), as the rows Undo sits
/// under do.
fn message_changed_files(metadata: &JsonValue) -> bool {
    metadata
        .get("artifacts")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|artifact| artifact.get("kind").and_then(JsonValue::as_str) == Some("apply/files"))
        .filter_map(|artifact| artifact.get("files").and_then(JsonValue::as_array))
        .flatten()
        .any(|file| {
            let read_only = |value: Option<&JsonValue>| {
                value
                    .and_then(JsonValue::as_str)
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case("read"))
            };
            file.get("path").and_then(JsonValue::as_str).is_some()
                && !read_only(file.get("changeType"))
                && !read_only(file.get("change"))
                && !read_only(file.pointer("/change/type"))
        })
}

async fn record_change_undone(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, message_id_raw)): AxumPath<(String, String)>,
) -> Result<Json<ConversationMessagePayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    // Only a person presses Undo.
    let actor_user_id = crate::auth::require_user_session(&context)?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let message_id = Uuid::from_str(message_id_raw.trim())
        .map_err(|_| bad_request("messageId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let changed = transaction
        .query_opt(
            "select id, conversation_id, project_id, session_id, created_by, prompt_id,
                    run_id, role, content, metadata, created_at
               from conversation_messages
              where id = $1 and project_id = $2",
            &[&message_id, &project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the changed message: {error}")))?
        .map(|row| map_conversation_message_row(&row))
        .ok_or_else(|| not_found("message not found"))?;
    let conversation = load_conversation_record(&transaction, &changed.conversation_id).await?;
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    // Undo changes the space: only someone who may write it records one.
    ensure_project_write_access(&transaction, &project, &context, conversation.session_id).await?;
    ensure_conversation_access(&transaction, &conversation, &context).await?;
    ensure_not_internal_conversation(&transaction, &conversation.id).await?;
    if !changed.role.eq_ignore_ascii_case("assistant") || !message_changed_files(&changed.metadata)
    {
        return Err(bad_request("this message changed no files"));
    }

    // One line per change, however often Studio reports it.
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&format!("change-undone:{message_id}")],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock the undone change: {error}")))?;
    let existing = transaction
        .query_opt(
            "select id, conversation_id, project_id, session_id, created_by, prompt_id,
                    run_id, role, content, metadata, created_at
               from conversation_messages
              where conversation_id = $1
                and metadata->>'kind' = $2
                and metadata->>'undoneMessageId' = $3
              order by created_at
              limit 1",
            &[
                &conversation.id,
                &CHANGE_UNDONE_KIND,
                &message_id.to_string(),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to look for the undo line: {error}")))?;
    if let Some(row) = existing {
        let message = map_conversation_message_row(&row);
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to finish: {error}")))?;
        return Ok(Json(message_row_to_payload(&message)));
    }

    let request = request_of_change(&transaction, &changed).await?;
    let content = change_undone_line(request.as_deref().unwrap_or("an earlier message"));
    let mut metadata = json!({
        "source": "controller",
        "kind": CHANGE_UNDONE_KIND,
        "presentation": { "hidden": true },
        "undoneMessageId": message_id.to_string(),
        "actorUserId": actor_user_id.to_string(),
    });
    if let Some(run_id) = changed.run_id {
        metadata["undoneRunId"] = json!(run_id.to_string());
    }
    let row = transaction
        .query_one(
            "insert into conversation_messages (
                 id, conversation_id, project_id, session_id, prompt_id, run_id,
                 role, content, metadata, created_by
             ) values ($1, $2, $3, $4, null, null, 'assistant', $5, $6::jsonb, null)
             returning id, conversation_id, project_id, session_id, created_by, prompt_id,
                       run_id, role, content, metadata, created_at",
            &[
                &Uuid::new_v4(),
                &conversation.id,
                &conversation.project_id,
                &conversation.session_id,
                &content,
                &PgJson(&metadata),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record the undo: {error}")))?;
    let message = map_conversation_message_row(&row);
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to record the undo: {error}")))?;
    // Every open Studio of the chat shows the change as undone.
    publish_conversation_message_event(&state.events, &message);
    Ok(Json(message_row_to_payload(&message)))
}

/// The person's request that made `changed`: the message of its run in the
/// person's role, as the chat showed it, else the last one before it.
async fn request_of_change(
    transaction: &tokio_postgres::Transaction<'_>,
    changed: &ConversationMessageRow,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select coalesce(
                        nullif(btrim(metadata #>> '{prompt_metadata,displayContent}'), ''),
                        nullif(btrim(metadata ->> 'displayContent'), ''),
                        content) as request
               from conversation_messages
              where conversation_id = $1
                and lower(role) = 'user'
                and (($2::uuid is not null and run_id = $2) or created_at <= $3)
              order by ($2::uuid is not null and run_id = $2) desc, created_at desc
              limit 1",
            &[
                &changed.conversation_id,
                &changed.run_id,
                &changed.created_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to find the request: {error}")))?;
    Ok(row
        .map(|row| row.get::<_, String>("request"))
        .map(|request| request.trim().to_string())
        .filter(|request| !request.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_quotes_the_request_on_one_line() {
        assert_eq!(
            change_undone_line("Add a short \"Before you go\"\n section to that page."),
            "The person undid the change from “Add a short \"Before you go\" section to that page.”"
        );
        let long = "word ".repeat(60);
        let line = change_undone_line(&long);
        assert!(line.ends_with("…”"), "{line}");
        assert!(line.chars().count() < 200, "{line}");
    }

    #[test]
    fn only_a_message_that_changed_files_can_be_undone() {
        assert!(message_changed_files(&json!({
            "artifacts": [{ "kind": "apply/files", "files": [
                { "path": "sites/page/app.js", "change": { "type": "changed" } }
            ]}]
        })));
        assert!(!message_changed_files(&json!({
            "artifacts": [{ "kind": "apply/files", "files": [
                { "path": "sites/page/app.js", "changeType": "read" }
            ]}]
        })));
        assert!(!message_changed_files(&json!({ "artifacts": [] })));
        assert!(!message_changed_files(&JsonValue::Null));
    }
}
