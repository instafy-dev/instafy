//! What an Undo leaves in a chat's history.
//!
//! Undo in Studio takes a turn's change back without a turn of Octo's: a
//! saved change gets a new saved version that undoes it, and a change no save
//! took goes back in the folder. Neither is a message, so the history the
//! next turn and its routing step read never said so, and "keep going" carried
//! on the change the person had just undone.
//!
//! Studio now reports an Undo that worked here, with the files it put back or
//! removed, and the controller records one line in the chat's history, in its
//! own words: "The person undid the change from “…”", quoting the request
//! that made the change, and naming those files when the Undo left some of
//! the change's files as they were (a file the turn's save never took, say).
//! The request is the person's: a change made by a hand-back, Octo carrying on
//! a browser turn, quotes the message that browser turn carried on, never the
//! hand-back's own words. The line is kept out of the transcript
//! (`presentation.hidden`, as `activity::is_kept_out_of_transcript` and Studio
//! read it): no bubble and no notification, and it is no turn, so it costs no
//! credit and none of the day's messages. Nor does it become the chat's last
//! line on Home. Every later turn and routing step read it in the chat's
//! history (runtime-agent `conversation_context.rs`), and Studio reads it to
//! show those files as undone, with no Undo and no Continue, after a reload
//! too. Only the controller writes such a line: a message a client records
//! never keeps its `kind` (`conversations::sanitize_client_recorded_message_metadata`),
//! and the line's readers also require its `source`.

use std::str::FromStr;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
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
/// The most files one Undo may name.
const UNDONE_PATHS_MAX: usize = 1_000;
/// The most files a line names when the Undo left some of the change alone.
const NAMED_PATHS_MAX: usize = 10;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/:project_id/messages/:message_id/undone",
        post(record_change_undone),
    )
}

/// The line, quoting the request that made the change. `only` names the
/// files the Undo put back or removed when it left some of the change's
/// files as they were.
pub(crate) fn change_undone_line(request: &str, only: Option<&[String]>) -> String {
    let words = request.split_whitespace().collect::<Vec<_>>().join(" ");
    let quote = if words.chars().count() > REQUEST_QUOTE_MAX_CHARS {
        let cut: String = words.chars().take(REQUEST_QUOTE_MAX_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        words
    };
    let line = format!("The person undid the change from “{quote}”");
    let Some(paths) = only.filter(|paths| !paths.is_empty()) else {
        return line;
    };
    let mut named = paths
        .iter()
        .take(NAMED_PATHS_MAX)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > NAMED_PATHS_MAX {
        named.push_str(&format!(
            " and {} other files",
            paths.len() - NAMED_PATHS_MAX
        ));
    }
    format!("{line} in {named} only")
}

/// A workspace path as Studio's rows compare them.
fn normalize_path(path: &str) -> String {
    let mut path = path.trim().replace('\\', "/");
    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }
    path.trim_matches('/').to_string()
}

/// The change's files as its row lists them: each file once, by the path its
/// row shows (`workspacePath`, else `path`), as Studio sends them.
fn change_paths(metadata: &JsonValue) -> std::collections::BTreeSet<String> {
    metadata
        .get("artifacts")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|artifact| artifact.get("kind").and_then(JsonValue::as_str) == Some("apply/files"))
        .filter_map(|artifact| artifact.get("files").and_then(JsonValue::as_array))
        .flatten()
        .filter(|file| {
            let read_only = |value: Option<&JsonValue>| {
                value
                    .and_then(JsonValue::as_str)
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case("read"))
            };
            !read_only(file.get("changeType"))
                && !read_only(file.get("change"))
                && !read_only(file.pointer("/change/type"))
        })
        .filter_map(|file| {
            ["workspacePath", "path"]
                .into_iter()
                .filter_map(|key| file.get(key).and_then(JsonValue::as_str))
                .map(normalize_path)
                .find(|path| !path.is_empty())
        })
        .collect()
}

/// What Studio reports with an Undo that worked.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeUndoneBody {
    /// The files of the change the Undo put back or removed.
    #[serde(default)]
    paths: Vec<String>,
}

/// The files an earlier line already recorded as undone for that change.
fn undone_paths_of(line: &ConversationMessageRow) -> std::collections::BTreeSet<String> {
    line.metadata
        .get("undonePaths")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .map(normalize_path)
        .collect()
}

async fn record_change_undone(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id_raw, message_id_raw)): AxumPath<(String, String)>,
    Json(body): Json<ChangeUndoneBody>,
) -> Result<Json<ConversationMessagePayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    // Only a person presses Undo.
    let actor_user_id = crate::auth::require_user_session(&context)?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let message_id = Uuid::from_str(message_id_raw.trim())
        .map_err(|_| bad_request("messageId must be a valid UUID"))?;
    if body.paths.is_empty() || body.paths.len() > UNDONE_PATHS_MAX {
        return Err(bad_request("paths must name the files the Undo put back"));
    }

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
    let change_paths = change_paths(&changed.metadata);
    if !changed.role.eq_ignore_ascii_case("assistant") || change_paths.is_empty() {
        return Err(bad_request("this message changed no files"));
    }
    // Only this change's own files: the line says what the person took back.
    let undone: std::collections::BTreeSet<String> = body
        .paths
        .iter()
        .map(|path| normalize_path(path))
        .filter(|path| change_paths.contains(path))
        .collect();
    if undone.is_empty() {
        return Err(bad_request("none of these files are this change's"));
    }

    // One line per file of a change, however often Studio reports it: a
    // second Undo of the same files answers with the line already there.
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&format!("change-undone:{message_id}")],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock the undone change: {error}")))?;
    let earlier = transaction
        .query(
            "select id, conversation_id, project_id, session_id, created_by, prompt_id,
                    run_id, role, content, metadata, created_at
               from conversation_messages
              where conversation_id = $1
                and metadata->>'kind' = $2
                and metadata->>'source' = 'controller'
                and metadata->>'undoneMessageId' = $3
              order by created_at",
            &[
                &conversation.id,
                &CHANGE_UNDONE_KIND,
                &message_id.to_string(),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to look for the undo line: {error}")))?
        .iter()
        .map(map_conversation_message_row)
        .collect::<Vec<_>>();
    let already: std::collections::BTreeSet<String> =
        earlier.iter().flat_map(undone_paths_of).collect();
    let new_paths: Vec<String> = undone.difference(&already).cloned().collect();
    if new_paths.is_empty() {
        if let Some(line) = earlier.last() {
            transaction
                .commit()
                .await
                .map_err(|error| internal_error(format!("failed to finish: {error}")))?;
            return Ok(Json(message_row_to_payload(line)));
        }
    }

    let request = request_of_change(&transaction, &changed).await?;
    // The files are named when the Undo left some of the change as it was.
    let whole_change = change_paths.iter().all(|path| new_paths.contains(path));
    let content = change_undone_line(
        request.as_deref().unwrap_or("an earlier message"),
        (!whole_change).then_some(new_paths.as_slice()),
    );
    let mut metadata = json!({
        "source": "controller",
        "kind": CHANGE_UNDONE_KIND,
        "presentation": { "hidden": true },
        "undoneMessageId": message_id.to_string(),
        "undonePaths": new_paths,
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

/// What a message in the person's role shows: its `displayContent`, else its
/// text.
const SHOWN_REQUEST: &str = "coalesce(
    nullif(btrim(m.metadata #>> '{prompt_metadata,displayContent}'), ''),
    nullif(btrim(m.metadata ->> 'displayContent'), ''),
    m.content)";

/// The person's request that made `changed`: the message of its run in the
/// person's role, as the chat showed it. A hand-back (`browserHandBack`) is
/// Octo carrying on a browser turn, in the person's role but in Octo's words
/// ("Octo continued in the chat"), so its request is the person's message
/// whose turn asked for that browser turn (the record's `cardJobId`). Else,
/// the last message the person sent before the change that is no hand-back.
async fn request_of_change(
    transaction: &tokio_postgres::Transaction<'_>,
    changed: &ConversationMessageRow,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let failed = |error: tokio_postgres::Error| {
        internal_error(format!("failed to find the request: {error}"))
    };
    let words = |row: Option<tokio_postgres::Row>| {
        row.map(|row| row.get::<_, String>("request"))
            .map(|request| request.trim().to_string())
            .filter(|request| !request.is_empty())
    };
    if let Some(run_id) = changed.run_id {
        let own = transaction
            .query_opt(
                &format!(
                    "select {SHOWN_REQUEST} as request,
                            coalesce(m.metadata #>> '{{browserHandBack,cardJobId}}',
                                     m.metadata #>> '{{prompt_metadata,browserHandBack,cardJobId}}')
                              as card_job_id,
                            (m.metadata -> 'browserHandBack' is not null
                             or m.metadata #> '{{prompt_metadata,browserHandBack}}' is not null)
                              as hand_back
                       from conversation_messages m
                      where m.conversation_id = $1
                        and lower(m.role) = 'user'
                        and m.run_id = $2
                      order by m.created_at
                      limit 1"
                ),
                &[&changed.conversation_id, &run_id],
            )
            .await
            .map_err(failed)?;
        if let Some(own) = own {
            if !own.get::<_, bool>("hand_back") {
                return Ok(words(Some(own)));
            }
            let card_job_id = own
                .get::<_, Option<String>>("card_job_id")
                .and_then(|raw| Uuid::parse_str(raw.trim()).ok());
            if let Some(card_job_id) = card_job_id {
                let card_turn = transaction
                    .query_opt(
                        &format!(
                            "select {SHOWN_REQUEST} as request
                               from agent_jobs j
                               join conversation_messages m
                                 on m.run_id = j.run_id and m.conversation_id = j.conversation_id
                              where j.id = $1
                                and j.conversation_id = $2
                                and lower(m.role) = 'user'
                                and m.metadata -> 'browserHandBack' is null
                                and m.metadata #> '{{prompt_metadata,browserHandBack}}' is null
                              order by m.created_at
                              limit 1"
                        ),
                        &[&card_job_id, &changed.conversation_id],
                    )
                    .await
                    .map_err(failed)?;
                if let Some(request) = words(card_turn) {
                    return Ok(Some(request));
                }
            }
        }
    }
    let last = transaction
        .query_opt(
            &format!(
                "select {SHOWN_REQUEST} as request
                   from conversation_messages m
                  where m.conversation_id = $1
                    and lower(m.role) = 'user'
                    and m.created_at <= $2
                    and m.metadata -> 'browserHandBack' is null
                    and m.metadata #> '{{prompt_metadata,browserHandBack}}' is null
                  order by m.created_at desc
                  limit 1"
            ),
            &[&changed.conversation_id, &changed.created_at],
        )
        .await
        .map_err(failed)?;
    Ok(words(last))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_quotes_the_request_on_one_line() {
        assert_eq!(
            change_undone_line("Add a short \"Before you go\"\n section to that page.", None),
            "The person undid the change from “Add a short \"Before you go\" section to that page.”"
        );
        let long = "word ".repeat(60);
        let line = change_undone_line(&long, None);
        assert!(line.ends_with("…”"), "{line}");
        assert!(line.chars().count() < 200, "{line}");
    }

    #[test]
    fn only_a_message_that_changed_files_can_be_undone() {
        assert_eq!(
            change_paths(&json!({
                "artifacts": [{ "kind": "apply/files", "files": [
                    { "path": "/workspace/p/sites/page/app.js", "workspacePath": "sites/page/app.js", "change": { "type": "changed" } },
                    { "path": "./sites/page/index.html", "change": { "type": "created" } }
                ]}]
            }))
            .into_iter()
            .collect::<Vec<_>>(),
            ["sites/page/app.js", "sites/page/index.html"]
        );
        assert!(change_paths(&json!({
            "artifacts": [{ "kind": "apply/files", "files": [
                { "path": "sites/page/app.js", "changeType": "read" }
            ]}]
        }))
        .is_empty());
        assert!(change_paths(&json!({ "artifacts": [] })).is_empty());
        assert!(change_paths(&JsonValue::Null).is_empty());
    }

    #[test]
    fn a_line_for_part_of_a_change_names_the_files_it_undid() {
        assert_eq!(
            change_undone_line("Add a section.", Some(&["sites/page/app.js".to_string()])),
            "The person undid the change from “Add a section.” in sites/page/app.js only"
        );
        let many = (0..12).map(|n| format!("f{n}.js")).collect::<Vec<_>>();
        let line = change_undone_line("Add a section.", Some(&many));
        assert!(line.ends_with("f9.js and 2 other files only"), "{line}");
    }

    /// Anyone who can write a chat can record a message in it; none of them
    /// can make it an Undo's line, which marks a change undone in every
    /// Studio and reaches later turns.
    #[test]
    fn a_recorded_message_never_claims_to_be_an_undo_line() {
        let forged = json!({
            "kind": "change_undone",
            "presentation": { "hidden": true },
            "undoneMessageId": "00000000-0000-4000-8000-000000000001",
            "custom": "kept",
        });
        let sanitized =
            crate::conversations::sanitize_client_recorded_message_metadata(forged, false);
        assert!(sanitized.get("kind").is_none(), "{sanitized}");
        assert!(sanitized.get("source").is_none(), "{sanitized}");
        assert_eq!(sanitized["custom"], "kept");
        let claimed = crate::conversations::sanitize_client_recorded_message_metadata(
            json!({ "source": "controller", "kind": "change_undone" }),
            false,
        );
        assert!(
            claimed.get("kind").is_none() && claimed.get("source").is_none(),
            "{claimed}"
        );
    }
}
