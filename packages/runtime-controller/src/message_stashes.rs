use std::str::FromStr;

use axum::extract::Path as AxumPath;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session, RequestContext};
use crate::conversations::{
    ensure_conversation_access, load_conversation_record, ConversationRecord,
};
use crate::{
    bad_request, ensure_project_access, ensure_project_write_access, internal_error, not_found,
    ApiError, AppState,
};

const MAX_STASH_TEXT_BYTES: usize = 1024 * 1024;
const MAX_STASH_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_STASHES_PER_OWNER_CONVERSATION: i64 = 50;
const MAX_STASH_AGGREGATE_PAYLOAD_BYTES: i64 = 5 * 1024 * 1024;
const MAX_CLIENT_STASH_ID_CHARS: usize = 200;
const STASH_LIMIT_ERROR_CODE: &str = "message_stash_limit_reached";
const STASH_STORAGE_LIMIT_ERROR_CODE: &str = "message_stash_storage_limit_reached";
const STASH_IDEMPOTENCY_CONFLICT_ERROR_CODE: &str = "message_stash_idempotency_conflict";
const STASH_COLUMNS: &str =
    "id, project_id, conversation_id, client_stash_id, payload, created_at, updated_at";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations/:conversation_id/message-stashes",
            get(list_message_stashes).post(create_message_stash),
        )
        .route(
            "/conversations/:conversation_id/message-stashes/:stash_id",
            delete(delete_message_stash)
                .patch(update_message_stash)
                .put(update_message_stash),
        )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageStashBody {
    #[serde(default)]
    pub(crate) client_stash_id: Option<String>,
    pub(crate) text: String,
    pub(crate) editor_state: JsonValue,
    pub(crate) composer_envelope: JsonValue,
}

#[derive(Debug)]
struct ValidatedStashPayload {
    value: JsonValue,
}

struct StashRequest {
    conversation_id: Uuid,
    owner_user_id: Uuid,
    context: RequestContext,
}

#[derive(Clone, Copy)]
enum StashAccess {
    Read,
    Write,
}

fn normalize_client_stash_id(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Err(bad_request("clientStashId must not be empty"));
    }
    if normalized.chars().count() > MAX_CLIENT_STASH_ID_CHARS {
        return Err(bad_request(format!(
            "clientStashId must be at most {MAX_CLIENT_STASH_ID_CHARS} characters"
        )));
    }
    Ok(normalized.to_string())
}

fn stash_payload(
    body: MessageStashBody,
) -> Result<ValidatedStashPayload, (StatusCode, Json<ApiError>)> {
    if body.text.len() > MAX_STASH_TEXT_BYTES {
        return Err(bad_request("stash text is too large"));
    }
    if !body.composer_envelope.is_object() {
        return Err(bad_request("composerEnvelope must be a JSON object"));
    }
    let payload = json!({
        "text": body.text,
        "editorState": body.editor_state,
        "composerEnvelope": body.composer_envelope,
    });
    let payload_bytes = serde_json::to_vec(&payload)
        .map_err(|error| bad_request(format!("stash payload is not valid JSON: {error}")))?;
    if payload_bytes.len() > MAX_STASH_PAYLOAD_BYTES {
        return Err(bad_request("stash payload is too large"));
    }
    Ok(ValidatedStashPayload { value: payload })
}

fn stash_row_to_json(row: &tokio_postgres::Row) -> JsonValue {
    let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
    json!({
        "id": row.get::<_, Uuid>("id"),
        "projectId": row.get::<_, Uuid>("project_id"),
        "conversationId": row.get::<_, Uuid>("conversation_id"),
        "clientStashId": row.get::<_, String>("client_stash_id"),
        "text": payload.get("text").cloned().unwrap_or(JsonValue::String(String::new())),
        "editorState": payload.get("editorState").cloned().unwrap_or(JsonValue::Null),
        "composerEnvelope": payload.get("composerEnvelope").cloned().unwrap_or_else(|| json!({})),
        "createdAt": row.get::<_, chrono::DateTime<chrono::Utc>>("created_at"),
        "updatedAt": row.get::<_, chrono::DateTime<chrono::Utc>>("updated_at"),
    })
}

fn stash_limit_reached() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::with_details(
            format!(
                "A conversation can have at most {MAX_STASHES_PER_OWNER_CONVERSATION} message stashes per user"
            ),
            STASH_LIMIT_ERROR_CODE,
            json!({ "limit": MAX_STASHES_PER_OWNER_CONVERSATION }),
        )),
    )
}

fn stash_storage_limit_reached() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::with_details(
            format!(
                "Message stashes can use at most {MAX_STASH_AGGREGATE_PAYLOAD_BYTES} bytes per conversation and user"
            ),
            STASH_STORAGE_LIMIT_ERROR_CODE,
            json!({ "limitBytes": MAX_STASH_AGGREGATE_PAYLOAD_BYTES }),
        )),
    )
}

fn stash_idempotency_conflict(client_stash_id: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::with_details(
            "clientStashId is already bound to a different message stash",
            STASH_IDEMPOTENCY_CONFLICT_ERROR_CODE,
            json!({ "clientStashId": client_stash_id }),
        )),
    )
}

async fn resolve_stash_request(
    state: &AppState,
    headers: &HeaderMap,
    conversation_id_raw: &str,
) -> Result<StashRequest, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    let owner_user_id = require_user_session(&context)?;
    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;

    Ok(StashRequest {
        conversation_id,
        owner_user_id,
        context,
    })
}

async fn authorize_stash_access(
    transaction: &Transaction<'_>,
    request: &StashRequest,
    required_access: StashAccess,
) -> Result<ConversationRecord, (StatusCode, Json<ApiError>)> {
    let conversation = load_conversation_record(transaction, &request.conversation_id).await?;
    let project = crate::load_project_record(transaction, &conversation.project_id).await?;
    match required_access {
        StashAccess::Read => {
            ensure_project_access(
                transaction,
                &project,
                &request.context,
                conversation.session_id,
            )
            .await?;
        }
        StashAccess::Write => {
            ensure_project_write_access(
                transaction,
                &project,
                &request.context,
                conversation.session_id,
            )
            .await?;
        }
    }
    // Human conversation write authority is the intersection of project write
    // access and conversation access. Unlike scoped job tokens, interactive
    // sessions do not have a separate conversation-write capability object.
    ensure_conversation_access(transaction, &conversation, &request.context).await?;
    Ok(conversation)
}

async fn lock_stash_owner_conversation(
    transaction: &Transaction<'_>,
    conversation_id: Uuid,
    owner_user_id: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    // A row lock cannot serialize the zero-row case. Use an owner/conversation
    // transaction-scoped advisory lock so quota and idempotency decisions stay
    // correct across simultaneous creates and updates.
    let quota_lock_key = format!("message-stash-quota:{conversation_id}:{owner_user_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&quota_lock_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock message stash quota: {error}")))?;
    Ok(())
}

async fn ensure_stash_storage_quota(
    transaction: &Transaction<'_>,
    conversation_id: Uuid,
    owner_user_id: Uuid,
    replacing_payload_bytes: i64,
    candidate_payload: &JsonValue,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let candidate_payload_param = PgJson(candidate_payload);
    let quota = transaction
        .query_one(
            "select (
               select coalesce(sum(octet_length(payload::text)), 0)::bigint
               from conversation_message_stashes
               where conversation_id = $1
                 and owner_user_id = $2
             ) as stored_payload_bytes,
             octet_length($3::jsonb::text)::bigint as candidate_payload_bytes",
            &[&conversation_id, &owner_user_id, &candidate_payload_param],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect message stash storage quota: {error}"
            ))
        })?;
    let stored_payload_bytes: i64 = quota.get("stored_payload_bytes");
    let candidate_payload_bytes: i64 = quota.get("candidate_payload_bytes");
    if stored_payload_bytes
        .saturating_sub(replacing_payload_bytes)
        .saturating_add(candidate_payload_bytes)
        > MAX_STASH_AGGREGATE_PAYLOAD_BYTES
    {
        return Err(stash_storage_limit_reached());
    }
    Ok(())
}

async fn insert_message_stash(
    transaction: &Transaction<'_>,
    conversation: &ConversationRecord,
    owner_user_id: Uuid,
    client_stash_id: &str,
    payload: &JsonValue,
) -> Result<tokio_postgres::Row, (StatusCode, Json<ApiError>)> {
    lock_stash_owner_conversation(transaction, conversation.id, owner_user_id).await?;

    if let Some(existing) = transaction
        .query_opt(
            &format!(
                "select {STASH_COLUMNS}
                 from conversation_message_stashes
                 where conversation_id = $1
                   and owner_user_id = $2
                   and client_stash_id = $3"
            ),
            &[&conversation.id, &owner_user_id, &client_stash_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load idempotent message stash: {error}"))
        })?
    {
        let existing_payload = existing.get::<_, PgJson<JsonValue>>("payload").0;
        if existing_payload != *payload {
            return Err(stash_idempotency_conflict(client_stash_id));
        }
        return Ok(existing);
    }

    let stash_count = transaction
        .query_one(
            "select count(*)
             from conversation_message_stashes
             where conversation_id = $1
               and owner_user_id = $2",
            &[&conversation.id, &owner_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to inspect message stash quota: {error}")))?
        .get::<_, i64>(0);
    if stash_count >= MAX_STASHES_PER_OWNER_CONVERSATION {
        return Err(stash_limit_reached());
    }

    ensure_stash_storage_quota(transaction, conversation.id, owner_user_id, 0, payload).await?;

    let payload_param = PgJson(payload);
    transaction
        .query_one(
            &format!(
                "insert into conversation_message_stashes (
                     project_id, conversation_id, owner_user_id, client_stash_id, payload
                 ) values ($1, $2, $3, $4, $5::jsonb)
                 returning {STASH_COLUMNS}"
            ),
            &[
                &conversation.project_id,
                &conversation.id,
                &owner_user_id,
                &client_stash_id,
                &payload_param,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to create message stash: {error}")))
}

async fn load_message_stash_rows(
    transaction: &Transaction<'_>,
    conversation_id: Uuid,
    owner_user_id: Uuid,
) -> Result<Vec<tokio_postgres::Row>, (StatusCode, Json<ApiError>)> {
    transaction
        .query(
            &format!(
                "select {STASH_COLUMNS}
                 from (
                   select {STASH_COLUMNS},
                          sum(octet_length(payload::text)) over (
                            order by updated_at desc, id desc
                            rows between unbounded preceding and current row
                          )::bigint as cumulative_payload_bytes
                   from conversation_message_stashes
                   where conversation_id = $1
                     and owner_user_id = $2
                 ) bounded_stashes
                 where cumulative_payload_bytes <= $3
                 order by updated_at desc, id desc
                 limit {MAX_STASHES_PER_OWNER_CONVERSATION}"
            ),
            &[
                &conversation_id,
                &owner_user_id,
                &MAX_STASH_AGGREGATE_PAYLOAD_BYTES,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list message stashes: {error}")))
}

async fn update_message_stash_row(
    transaction: &Transaction<'_>,
    conversation: &ConversationRecord,
    owner_user_id: Uuid,
    stash_id: Uuid,
    supplied_client_stash_id: Option<&str>,
    payload: &JsonValue,
) -> Result<tokio_postgres::Row, (StatusCode, Json<ApiError>)> {
    lock_stash_owner_conversation(transaction, conversation.id, owner_user_id).await?;
    let existing = transaction
        .query_opt(
            &format!(
                "select {STASH_COLUMNS}, octet_length(payload::text)::bigint as payload_bytes
                 from conversation_message_stashes
                 where id = $1
                   and conversation_id = $2
                   and owner_user_id = $3
                 for update"
            ),
            &[&stash_id, &conversation.id, &owner_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load message stash: {error}")))?;
    let Some(existing) = existing else {
        return Err(not_found("message stash not found"));
    };
    let existing_client_stash_id: String = existing.get("client_stash_id");
    if let Some(supplied_client_stash_id) = supplied_client_stash_id {
        if supplied_client_stash_id != existing_client_stash_id {
            return Err(stash_idempotency_conflict(supplied_client_stash_id));
        }
    }

    let existing_payload_bytes: i64 = existing.get("payload_bytes");
    ensure_stash_storage_quota(
        transaction,
        conversation.id,
        owner_user_id,
        existing_payload_bytes,
        payload,
    )
    .await?;
    let payload_param = PgJson(payload);
    transaction
        .query_one(
            &format!(
                "update conversation_message_stashes
                 set payload = $4::jsonb, updated_at = now()
                 where id = $1
                   and conversation_id = $2
                   and owner_user_id = $3
                 returning {STASH_COLUMNS}"
            ),
            &[&stash_id, &conversation.id, &owner_user_id, &payload_param],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update message stash: {error}")))
}

pub(crate) async fn create_message_stash(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    Json(body): Json<MessageStashBody>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let request = resolve_stash_request(&state, &headers, &conversation_id_raw).await?;
    let client_stash_id = body
        .client_stash_id
        .as_deref()
        .ok_or_else(|| bad_request("clientStashId is required"))
        .and_then(normalize_client_stash_id)?;
    let payload = stash_payload(body)?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start stash transaction: {error}")))?;
    let conversation = authorize_stash_access(&transaction, &request, StashAccess::Write).await?;
    let row = insert_message_stash(
        &transaction,
        &conversation,
        request.owner_user_id,
        &client_stash_id,
        &payload.value,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit message stash: {error}")))?;
    Ok(Json(stash_row_to_json(&row)))
}

pub(crate) async fn list_message_stashes(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
) -> Result<Json<Vec<JsonValue>>, (StatusCode, Json<ApiError>)> {
    let request = resolve_stash_request(&state, &headers, &conversation_id_raw).await?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start stash transaction: {error}")))?;
    let conversation = authorize_stash_access(&transaction, &request, StashAccess::Read).await?;
    let rows =
        load_message_stash_rows(&transaction, conversation.id, request.owner_user_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize stash list: {error}")))?;
    Ok(Json(rows.iter().map(stash_row_to_json).collect()))
}

pub(crate) async fn update_message_stash(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath((conversation_id_raw, stash_id_raw)): AxumPath<(String, String)>,
    Json(body): Json<MessageStashBody>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let request = resolve_stash_request(&state, &headers, &conversation_id_raw).await?;
    let stash_id = Uuid::from_str(stash_id_raw.trim())
        .map_err(|_| bad_request("stashId must be a valid UUID"))?;
    let supplied_client_stash_id = body
        .client_stash_id
        .as_deref()
        .map(normalize_client_stash_id)
        .transpose()?;
    let payload = stash_payload(body)?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start stash transaction: {error}")))?;
    let conversation = authorize_stash_access(&transaction, &request, StashAccess::Write).await?;
    let row = update_message_stash_row(
        &transaction,
        &conversation,
        request.owner_user_id,
        stash_id,
        supplied_client_stash_id.as_deref(),
        &payload.value,
    )
    .await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit message stash update: {error}"))
    })?;
    Ok(Json(stash_row_to_json(&row)))
}

pub(crate) async fn delete_message_stash(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath((conversation_id_raw, stash_id_raw)): AxumPath<(String, String)>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let request = resolve_stash_request(&state, &headers, &conversation_id_raw).await?;
    let stash_id = Uuid::from_str(stash_id_raw.trim())
        .map_err(|_| bad_request("stashId must be a valid UUID"))?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start stash transaction: {error}")))?;
    let conversation = authorize_stash_access(&transaction, &request, StashAccess::Write).await?;
    let row = transaction
        .query_opt(
            &format!(
                "delete from conversation_message_stashes
                 where id = $1
                   and conversation_id = $2
                   and owner_user_id = $3
                 returning {STASH_COLUMNS}"
            ),
            &[&stash_id, &conversation.id, &request.owner_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to delete message stash: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("message stash not found"));
    };
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit message stash delete: {error}"))
    })?;
    Ok(Json(
        json!({ "ok": true, "stash": stash_row_to_json(&row) }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn insert_test_user(pool: &crate::config::PgPool, user_id: Uuid) -> anyhow::Result<()> {
        pool.get()
            .await?
            .execute(
                "insert into auth.users (id) values ($1) on conflict (id) do nothing",
                &[&user_id],
            )
            .await?;
        Ok(())
    }

    async fn insert_stash_test_fixture(
        pool: &crate::config::PgPool,
        owner_user_id: Uuid,
        additional_user_ids: &[Uuid],
    ) -> anyhow::Result<(Uuid, Uuid)> {
        insert_test_user(pool, owner_user_id).await?;
        for user_id in additional_user_ids {
            insert_test_user(pool, *user_id).await?;
        }
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (
                     id, project_id, created_by, metadata, visibility
                 ) values ($1, $2, $3, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id, &owner_user_id],
            )
            .await?;
        Ok((project_id, conversation_id))
    }

    async fn cleanup_stash_test_fixture(
        pool: &crate::config::PgPool,
        project_id: Uuid,
        user_ids: &[Uuid],
    ) -> anyhow::Result<()> {
        let connection = pool.get().await?;
        connection
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        for user_id in user_ids {
            connection
                .execute("delete from auth.users where id = $1", &[user_id])
                .await?;
        }
        Ok(())
    }

    async fn load_test_conversation(
        pool: &crate::config::PgPool,
        conversation_id: Uuid,
    ) -> anyhow::Result<ConversationRecord> {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let conversation = load_conversation_record(&transaction, &conversation_id)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!(
                    "failed to load test conversation ({status}): {}",
                    error.message
                )
            })?;
        transaction.commit().await?;
        Ok(conversation)
    }

    async fn attempt_test_stash_insert(
        pool: crate::config::PgPool,
        conversation: ConversationRecord,
        owner_user_id: Uuid,
        text: &'static str,
    ) -> anyhow::Result<Result<(), (StatusCode, Option<String>)>> {
        let payload = json!({
            "text": text,
            "editorState": null,
            "composerEnvelope": {},
        });
        let client_stash_id = format!("test:{text}");
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        match insert_message_stash(
            &transaction,
            &conversation,
            owner_user_id,
            &client_stash_id,
            &payload,
        )
        .await
        {
            Ok(_) => {
                transaction.commit().await?;
                Ok(Ok(()))
            }
            Err((status, Json(error))) => Ok(Err((status, error.code))),
        }
    }

    #[test]
    fn stash_payload_preserves_opaque_editor_and_composer_state() {
        let payload = stash_payload(MessageStashBody {
            client_stash_id: None,
            text: "draft".to_string(),
            editor_state: json!({ "selection": [1, 2] }),
            composer_envelope: json!({ "attachments": [{ "id": "image-1" }] }),
        })
        .expect("valid stash");

        assert_eq!(payload.value["text"], "draft");
        assert_eq!(payload.value["editorState"]["selection"], json!([1, 2]));
        assert_eq!(
            payload.value["composerEnvelope"]["attachments"][0]["id"],
            "image-1"
        );
    }

    #[test]
    fn stash_payload_rejects_non_object_composer_envelopes() {
        let error = stash_payload(MessageStashBody {
            client_stash_id: None,
            text: String::new(),
            editor_state: JsonValue::Null,
            composer_envelope: json!(["not", "an", "object"]),
        })
        .expect_err("array envelope must be rejected");
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn stash_limit_error_has_a_stable_conflict_code_and_limit() {
        let (status, Json(error)) = stash_limit_reached();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some(STASH_LIMIT_ERROR_CODE));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value["limit"].as_i64()),
            Some(MAX_STASHES_PER_OWNER_CONVERSATION)
        );
    }

    #[tokio::test]
    async fn stash_writes_require_project_write_access_but_reads_allow_viewers(
    ) -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping stash write authorization test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let owner_user_id = Uuid::new_v4();
        let viewer_user_id = Uuid::new_v4();
        let (project_id, conversation_id) =
            insert_stash_test_fixture(&pool, owner_user_id, &[viewer_user_id]).await?;
        pool.get()
            .await?
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'viewer')",
                &[&project_id, &viewer_user_id],
            )
            .await?;

        let request = StashRequest {
            conversation_id,
            owner_user_id: viewer_user_id,
            context: RequestContext {
                user_id: Some(viewer_user_id),
                is_service_role: false,
                scoped_claims: None,
            },
        };
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        authorize_stash_access(&transaction, &request, StashAccess::Read)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("viewer stash read failed ({status}): {}", error.message)
            })?;
        let (status, _) = authorize_stash_access(&transaction, &request, StashAccess::Write)
            .await
            .expect_err("a viewer must not mutate message stashes");
        assert_eq!(status, StatusCode::FORBIDDEN);
        transaction.commit().await?;
        drop(connection);

        cleanup_stash_test_fixture(&pool, project_id, &[viewer_user_id, owner_user_id]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_stash_creates_cannot_exceed_the_owner_conversation_limit(
    ) -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping concurrent stash quota test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let owner_user_id = Uuid::new_v4();
        let (project_id, conversation_id) =
            insert_stash_test_fixture(&pool, owner_user_id, &[]).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversation_message_stashes (
                     project_id, conversation_id, owner_user_id, client_stash_id, payload
                 )
                 select $1, $2, $3, 'quota-fixture:' || value,
                        jsonb_build_object(
                            'text', 'existing-' || value,
                            'editorState', null,
                            'composerEnvelope', '{}'::jsonb
                        )
                 from generate_series(1, $4::integer) as value",
                &[
                    &project_id,
                    &conversation_id,
                    &owner_user_id,
                    &((MAX_STASHES_PER_OWNER_CONVERSATION - 1) as i32),
                ],
            )
            .await?;
        drop(connection);
        let conversation = load_test_conversation(&pool, conversation_id).await?;

        let (first, second) = tokio::join!(
            attempt_test_stash_insert(
                pool.clone(),
                conversation.clone(),
                owner_user_id,
                "concurrent-a",
            ),
            attempt_test_stash_insert(pool.clone(), conversation, owner_user_id, "concurrent-b",)
        );
        let outcomes = [first?, second?];
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        let rejected = outcomes
            .iter()
            .find_map(|outcome| outcome.as_ref().err())
            .expect("one concurrent create must hit the quota");
        assert_eq!(rejected.0, StatusCode::CONFLICT);
        assert_eq!(rejected.1.as_deref(), Some(STASH_LIMIT_ERROR_CODE));

        let connection = pool.get().await?;
        let final_count = connection
            .query_one(
                "select count(*)
                 from conversation_message_stashes
                 where conversation_id = $1 and owner_user_id = $2",
                &[&conversation_id, &owner_user_id],
            )
            .await?
            .get::<_, i64>(0);
        assert_eq!(final_count, MAX_STASHES_PER_OWNER_CONVERSATION);
        drop(connection);

        cleanup_stash_test_fixture(&pool, project_id, &[owner_user_id]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn stash_create_replay_precedes_quota_and_detects_payload_conflicts() -> anyhow::Result<()>
    {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping stash idempotency test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let owner_user_id = Uuid::new_v4();
        let (project_id, conversation_id) =
            insert_stash_test_fixture(&pool, owner_user_id, &[]).await?;
        let conversation = load_test_conversation(&pool, conversation_id).await?;
        let client_stash_id = "stash-retry-1";
        let payload = json!({
            "text": "keep this draft",
            "editorState": null,
            "composerEnvelope": {},
        });

        let first_id = {
            let mut connection = pool.get().await?;
            let transaction = connection.transaction().await?;
            let row = insert_message_stash(
                &transaction,
                &conversation,
                owner_user_id,
                client_stash_id,
                &payload,
            )
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("first stash create failed ({status}): {}", error.message)
            })?;
            let id = row.get::<_, Uuid>("id");
            transaction.commit().await?;
            id
        };

        pool.get()
            .await?
            .execute(
                "insert into conversation_message_stashes (
                     project_id, conversation_id, owner_user_id, client_stash_id, payload
                 )
                 select $1, $2, $3, 'idempotency-quota:' || value,
                        jsonb_build_object(
                            'text', 'existing-' || value,
                            'editorState', null,
                            'composerEnvelope', '{}'::jsonb
                        )
                 from generate_series(1, $4::integer) as value",
                &[
                    &project_id,
                    &conversation_id,
                    &owner_user_id,
                    &((MAX_STASHES_PER_OWNER_CONVERSATION - 1) as i32),
                ],
            )
            .await?;

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let replay = insert_message_stash(
            &transaction,
            &conversation,
            owner_user_id,
            client_stash_id,
            &payload,
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!("idempotent replay failed ({status}): {}", error.message)
        })?;
        assert_eq!(replay.get::<_, Uuid>("id"), first_id);
        transaction.commit().await?;
        drop(connection);

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let conflict = match insert_message_stash(
            &transaction,
            &conversation,
            owner_user_id,
            client_stash_id,
            &json!({
                "text": "different draft",
                "editorState": null,
                "composerEnvelope": {},
            }),
        )
        .await
        {
            Ok(_) => panic!("same client id with a different payload must conflict"),
            Err(error) => error,
        };
        let (status, Json(error)) = conflict;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            error.code.as_deref(),
            Some(STASH_IDEMPOTENCY_CONFLICT_ERROR_CODE)
        );
        transaction.rollback().await?;
        drop(connection);

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let immutable_id_conflict = match update_message_stash_row(
            &transaction,
            &conversation,
            owner_user_id,
            first_id,
            Some("different-client-stash-id"),
            &payload,
        )
        .await
        {
            Ok(_) => panic!("an update must not replace the immutable client stash id"),
            Err(error) => error,
        };
        let (status, Json(error)) = immutable_id_conflict;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            error.code.as_deref(),
            Some(STASH_IDEMPOTENCY_CONFLICT_ERROR_CODE)
        );
        transaction.rollback().await?;
        drop(connection);

        let final_count = pool
            .get()
            .await?
            .query_one(
                "select count(*) from conversation_message_stashes
                 where conversation_id = $1 and owner_user_id = $2",
                &[&conversation_id, &owner_user_id],
            )
            .await?
            .get::<_, i64>(0);
        assert_eq!(final_count, MAX_STASHES_PER_OWNER_CONVERSATION);

        cleanup_stash_test_fixture(&pool, project_id, &[owner_user_id]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn aggregate_storage_quota_bounds_create_update_and_legacy_lists() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping stash storage quota test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let owner_user_id = Uuid::new_v4();
        let (project_id, conversation_id) =
            insert_stash_test_fixture(&pool, owner_user_id, &[]).await?;
        let conversation = load_test_conversation(&pool, conversation_id).await?;
        let payload_with_text = |text_bytes: usize| {
            json!({
                "text": "x".repeat(text_bytes),
                "editorState": null,
                "composerEnvelope": {},
            })
        };
        let maximum_text_payload = payload_with_text(MAX_STASH_TEXT_BYTES);
        let smaller_payload = payload_with_text(900_000);

        let smaller_stash_id = {
            let mut connection = pool.get().await?;
            let transaction = connection.transaction().await?;
            for index in 0..4 {
                insert_message_stash(
                    &transaction,
                    &conversation,
                    owner_user_id,
                    &format!("aggregate-large-{index}"),
                    &maximum_text_payload,
                )
                .await
                .map_err(|(status, Json(error))| {
                    anyhow::anyhow!("large stash seed failed ({status}): {}", error.message)
                })?;
            }
            let smaller = insert_message_stash(
                &transaction,
                &conversation,
                owner_user_id,
                "aggregate-smaller",
                &smaller_payload,
            )
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("smaller stash seed failed ({status}): {}", error.message)
            })?;
            let id = smaller.get::<_, Uuid>("id");
            transaction.commit().await?;
            id
        };

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let create_conflict = match insert_message_stash(
            &transaction,
            &conversation,
            owner_user_id,
            "aggregate-overflow",
            &payload_with_text(200_000),
        )
        .await
        {
            Ok(_) => panic!("aggregate-overflow create must be rejected"),
            Err(error) => error,
        };
        let (status, Json(error)) = create_conflict;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some(STASH_STORAGE_LIMIT_ERROR_CODE));
        transaction.rollback().await?;
        drop(connection);

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let update_conflict = match update_message_stash_row(
            &transaction,
            &conversation,
            owner_user_id,
            smaller_stash_id,
            Some("aggregate-smaller"),
            &maximum_text_payload,
        )
        .await
        {
            Ok(_) => panic!("aggregate-overflow update must be rejected"),
            Err(error) => error,
        };
        let (status, Json(error)) = update_conflict;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some(STASH_STORAGE_LIMIT_ERROR_CODE));
        transaction.rollback().await?;
        drop(connection);

        let legacy_payload = PgJson(payload_with_text(MAX_STASH_TEXT_BYTES));
        pool.get()
            .await?
            .execute(
                "insert into conversation_message_stashes (
                     project_id, conversation_id, owner_user_id, client_stash_id,
                     payload, updated_at
                 ) values ($1, $2, $3, 'legacy:over-quota', $4::jsonb, now() + interval '1 day')",
                &[
                    &project_id,
                    &conversation_id,
                    &owner_user_id,
                    &legacy_payload,
                ],
            )
            .await?;

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let rows = load_message_stash_rows(&transaction, conversation_id, owner_user_id)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("bounded legacy list failed ({status}): {}", error.message)
            })?;
        assert!(
            rows.len() < 6,
            "an over-quota legacy row set must be truncated"
        );
        let listed_ids = rows
            .iter()
            .map(|row| row.get::<_, Uuid>("id"))
            .collect::<Vec<_>>();
        let listed_payload_bytes = transaction
            .query_one(
                "select coalesce(sum(octet_length(payload::text)), 0)::bigint
                 from conversation_message_stashes
                 where id = any($1::uuid[])",
                &[&listed_ids],
            )
            .await?
            .get::<_, i64>(0);
        assert!(listed_payload_bytes <= MAX_STASH_AGGREGATE_PAYLOAD_BYTES);
        transaction.commit().await?;
        drop(connection);

        cleanup_stash_test_fixture(&pool, project_id, &[owner_user_id]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn stash_list_is_owner_private_and_capped_to_the_50_most_recent_rows(
    ) -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping stash list bound test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let owner_user_id = Uuid::new_v4();
        let other_user_id = Uuid::new_v4();
        let (project_id, conversation_id) =
            insert_stash_test_fixture(&pool, owner_user_id, &[other_user_id]).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversation_message_stashes (
                     project_id, conversation_id, owner_user_id, client_stash_id, payload, updated_at
                 )
                 select $1, $2, $3, 'list-fixture:' || value,
                        jsonb_build_object(
                            'text', 'owner-' || value,
                            'editorState', null,
                            'composerEnvelope', '{}'::jsonb
                        ),
                        timestamp with time zone '2026-01-01 00:00:00+00'
                            + value * interval '1 second'
                 from generate_series(1, 55) as value",
                &[&project_id, &conversation_id, &owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversation_message_stashes (
                     project_id, conversation_id, owner_user_id, client_stash_id, payload, updated_at
                 ) values (
                     $1, $2, $3, 'list-fixture:other',
                     '{\"text\":\"private-other-owner\",\"editorState\":null,\"composerEnvelope\":{}}'::jsonb,
                     timestamp with time zone '2027-01-01 00:00:00+00'
                 )",
                &[&project_id, &conversation_id, &other_user_id],
            )
            .await?;
        drop(connection);

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let rows = load_message_stash_rows(&transaction, conversation_id, owner_user_id)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("stash list failed ({status}): {}", error.message)
            })?;
        assert_eq!(rows.len(), MAX_STASHES_PER_OWNER_CONVERSATION as usize);
        let texts = rows
            .iter()
            .map(stash_row_to_json)
            .map(|stash| stash["text"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();
        assert_eq!(texts.first().map(String::as_str), Some("owner-55"));
        assert_eq!(texts.last().map(String::as_str), Some("owner-6"));
        assert!(!texts.iter().any(|text| text == "private-other-owner"));
        transaction.commit().await?;
        drop(connection);

        cleanup_stash_test_fixture(&pool, project_id, &[other_user_id, owner_user_id]).await?;
        Ok(())
    }
}
