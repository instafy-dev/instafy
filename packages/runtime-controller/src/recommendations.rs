//! Owner-private findings delivered as ordinary chats without executing proposed work.
//! Skills may submit one opener per run; replies may save narrowly scoped reminder preferences.
use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio_postgres::{types::Json as PgJson, Row, Transaction};
use uuid::Uuid;

use crate::active_job_auth::{
    authorize_active_job_if_scoped, ActiveJobAuthorization, ActiveJobProjectAccess,
};
use crate::auth::{authenticate_request, require_user_session, RequestContext};
use crate::conversations::{
    ensure_conversation_access, load_conversation_record, ConversationRecord,
};
use crate::projects::{ensure_project_access, ensure_project_write_access, load_project_record};
use crate::{bad_request, internal_error, not_found, ApiError, AppState};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

#[path = "recommendation_feedback.rs"]
mod feedback;
pub(crate) use feedback::deliver_due_reminders;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    conversation_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitRecommendation {
    key: String,
    title: String,
    reason: String,
    prompt: String,
    #[serde(default)]
    message: Option<String>,
    evidence: Vec<Evidence>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RecommendationStatus {
    Proposed,
    Accepted,
    Dismissed,
}

impl RecommendationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Accepted => "accepted",
            Self::Dismissed => "dismissed",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecideRecommendation {
    status: RecommendationStatus,
    accepted_conversation_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recommendation {
    id: Uuid,
    project_id: Uuid,
    key: String,
    title: String,
    reason: String,
    prompt: String,
    evidence: Vec<Evidence>,
    status: RecommendationStatus,
    accepted_conversation_id: Option<Uuid>,
    delivered: bool,
    delivered_conversation_id: Option<Uuid>,
    remind_at: Option<String>,
    timezone: Option<String>,
    last_reminded_at: Option<String>,
    created_at: String,
    updated_at: String,
    #[serde(skip)]
    source_conversation_id: Uuid,
    #[serde(skip)]
    prepared_conversation_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    limit: Option<i64>,
}

#[derive(Serialize)]
struct RecommendationList {
    recommendations: Vec<Recommendation>,
}

struct Reader {
    user_id: Uuid,
    context: RequestContext,
    active_job: Option<ActiveJobAuthorization>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .merge(feedback::router())
        .route(
            "/projects/:project_id/recommendations/review-conversation",
            post(prepare_review_conversation),
        )
        .route(
            "/projects/:project_id/recommendations",
            get(list_recommendations).post(submit_recommendation),
        )
        .route(
            "/projects/:project_id/recommendations/:recommendation_id/prepare-conversation",
            post(prepare_action_conversation),
        )
        .route(
            "/projects/:project_id/recommendations/:recommendation_id",
            patch(decide_recommendation),
        )
}

fn normalize_text(raw: &str, label: &str, max: usize) -> ApiResult<String> {
    let text = raw.trim();
    if text.is_empty() || text.chars().count() > max || text.contains('\0') {
        return Err(bad_request(format!("{label} must be 1-{max} characters")));
    }
    Ok(text.to_owned())
}

fn normalize_submission(mut body: SubmitRecommendation) -> ApiResult<SubmitRecommendation> {
    body.key = body.key.trim().to_ascii_lowercase();
    if body.key.is_empty()
        || body.key.len() > 120
        || !body.key.as_bytes()[0].is_ascii_alphanumeric()
        || !body
            .key
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
    {
        return Err(bad_request(
            "key must be a lowercase ASCII slug of 1-120 characters",
        ));
    }
    body.title = normalize_text(&body.title, "title", 160)?;
    body.reason = normalize_text(&body.reason, "reason", 2000)?;
    body.prompt = normalize_text(&body.prompt, "prompt", 4000)?;
    body.message = body
        .message
        .as_deref()
        .map(|value| normalize_text(value, "message", 4000))
        .transpose()?;
    if body.evidence.is_empty() || body.evidence.len() > 8 {
        return Err(bad_request(
            "evidence must contain 1-8 conversation or message references",
        ));
    }
    let mut seen = HashSet::new();
    body.evidence.retain(|entry| seen.insert(entry.clone()));
    Ok(body)
}

async fn authorize(
    transaction: &Transaction<'_>,
    state: &AppState,
    context: RequestContext,
    project_id: &Uuid,
    access: ActiveJobProjectAccess,
) -> ApiResult<Reader> {
    let active_job = authorize_active_job_if_scoped(transaction, state, &context, access).await?;
    let (user_id, subject_context) = if let Some(job) = active_job.as_ref() {
        job.ensure_project_id(project_id)?;
        (job.subject_user_id, job.subject_context())
    } else {
        (require_user_session(&context)?, context)
    };
    let project = load_project_record(transaction, project_id).await?;
    match access {
        ActiveJobProjectAccess::Read => {
            ensure_project_access(transaction, &project, &subject_context, None).await?;
        }
        ActiveJobProjectAccess::Write => {
            ensure_project_write_access(transaction, &project, &subject_context, None).await?;
        }
    }
    Ok(Reader {
        user_id,
        context: subject_context,
        active_job,
    })
}

async fn validate_conversation(
    transaction: &Transaction<'_>,
    reader: &Reader,
    project_id: &Uuid,
    conversation_id: &Uuid,
) -> ApiResult<ConversationRecord> {
    let conversation = load_conversation_record(transaction, conversation_id).await?;
    if conversation.project_id != *project_id {
        return Err(not_found("recommendation evidence is unavailable"));
    }
    if let Some(job) = reader.active_job.as_ref() {
        job.ensure_conversation_read(transaction, &conversation)
            .await?;
    } else {
        ensure_conversation_access(transaction, &conversation, &reader.context).await?;
    }
    Ok(conversation)
}

async fn validate_evidence(
    transaction: &Transaction<'_>,
    reader: &Reader,
    project_id: &Uuid,
    evidence: &[Evidence],
) -> ApiResult<()> {
    for entry in evidence {
        validate_conversation(transaction, reader, project_id, &entry.conversation_id).await?;
        if let Some(message_id) = entry.message_id {
            let exists = transaction.query_opt(
                "select id from conversation_messages where id = $1 and conversation_id = $2 and project_id = $3",
                &[&message_id, &entry.conversation_id, project_id],
            ).await.map_err(|error| internal_error(format!("failed to validate recommendation evidence: {error}")))?;
            if exists.is_none() {
                return Err(not_found("recommendation evidence is unavailable"));
            }
        }
    }
    Ok(())
}

async fn validate_record(
    transaction: &Transaction<'_>,
    reader: &Reader,
    record: &Recommendation,
) -> ApiResult<()> {
    validate_conversation(
        transaction,
        reader,
        &record.project_id,
        &record.source_conversation_id,
    )
    .await?;
    validate_evidence(transaction, reader, &record.project_id, &record.evidence).await?;
    Ok(())
}

// The decision remains reviewable even if its later work continues in another
// private root. That root's identifier is not a permission to read it.
async fn redact_continuation(
    transaction: &Transaction<'_>,
    reader: &Reader,
    record: &mut Recommendation,
) -> ApiResult<()> {
    if let Some(conversation_id) = record.accepted_conversation_id {
        match validate_conversation(transaction, reader, &record.project_id, &conversation_id).await
        {
            Ok(_) => {}
            Err((StatusCode::FORBIDDEN | StatusCode::NOT_FOUND, _)) => {
                record.accepted_conversation_id = None
            }
            Err(error) => return Err(error),
        }
    }
    if let Some(conversation_id) = record.delivered_conversation_id {
        match validate_conversation(transaction, reader, &record.project_id, &conversation_id).await
        {
            Ok(_) => {}
            Err((StatusCode::FORBIDDEN | StatusCode::NOT_FOUND, _)) => {
                record.delivered_conversation_id = None
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn map_record(row: Row) -> ApiResult<Recommendation> {
    let evidence = serde_json::from_value(row.get::<_, PgJson<serde_json::Value>>("evidence").0)
        .map_err(|_| internal_error("invalid stored recommendation evidence"))?;
    let status = match row.get::<_, &str>("status") {
        "proposed" => RecommendationStatus::Proposed,
        "accepted" => RecommendationStatus::Accepted,
        "dismissed" => RecommendationStatus::Dismissed,
        _ => return Err(internal_error("invalid stored recommendation status")),
    };
    Ok(Recommendation {
        id: row.get("id"),
        project_id: row.get("project_id"),
        key: row.get("recommendation_key"),
        title: row.get("title"),
        reason: row.get("reason"),
        prompt: row.get("prompt"),
        evidence,
        status,
        accepted_conversation_id: row.get("accepted_conversation_id"),
        delivered: row
            .get::<_, Option<Uuid>>("delivered_conversation_id")
            .is_some(),
        delivered_conversation_id: row.get("delivered_conversation_id"),
        remind_at: row
            .get::<_, Option<DateTime<Utc>>>("remind_at")
            .map(|time| time.to_rfc3339()),
        timezone: row.get("reminder_timezone"),
        last_reminded_at: row
            .get::<_, Option<DateTime<Utc>>>("last_reminded_at")
            .map(|time| time.to_rfc3339()),
        created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
        updated_at: row.get::<_, DateTime<Utc>>("updated_at").to_rfc3339(),
        source_conversation_id: row.get("source_conversation_id"),
        prepared_conversation_id: row.get("prepared_conversation_id"),
    })
}

async fn list_recommendations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<RecommendationList>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("failed to get connection: {e}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("failed to start transaction: {e}")))?;
    let reader = authorize(
        &transaction,
        &state,
        context,
        &project_id,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    let rows = transaction.query(
        "select * from space_recommendations where project_id = $1 and user_id = $2 order by updated_at desc, id asc limit $3",
        &[&project_id, &reader.user_id, &query.limit.unwrap_or(100).clamp(1, 200)],
    ).await.map_err(|e| internal_error(format!("failed to list recommendations: {e}")))?;
    let mut recommendations = Vec::new();
    for row in rows {
        let mut record = map_record(row)?;
        match validate_record(&transaction, &reader, &record).await {
            Ok(()) => {
                redact_continuation(&transaction, &reader, &mut record).await?;
                recommendations.push(record);
            }
            Err((StatusCode::FORBIDDEN | StatusCode::NOT_FOUND, _)) => {}
            Err(error) => return Err(error),
        }
    }
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(format!("failed to commit recommendation list: {e}")))?;
    Ok(Json(RecommendationList { recommendations }))
}

async fn submit_recommendation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(body): Json<SubmitRecommendation>,
) -> ApiResult<Json<Recommendation>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let body = normalize_submission(body)?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("failed to get connection: {e}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("failed to start transaction: {e}")))?;
    let reader = authorize(
        &transaction,
        &state,
        context,
        &project_id,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    validate_evidence(&transaction, &reader, &project_id, &body.evidence).await?;
    let source_conversation_id = reader
        .active_job
        .as_ref()
        .map(|job| job.conversation_id)
        .unwrap_or(body.evidence[0].conversation_id);
    let evidence = PgJson(
        serde_json::to_value(&body.evidence)
            .map_err(|_| internal_error("failed to serialize evidence"))?,
    );
    // Insert-if-missing then lock: a concurrent review must authorize the old
    // record before replacing it, including its private source. Terminal rows
    // retain their content as well as their decision.
    transaction.execute(
        "insert into space_recommendations(user_id,project_id,recommendation_key,title,reason,prompt,evidence,source_conversation_id)
         values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(user_id,project_id,recommendation_key) do nothing",
        &[&reader.user_id,&project_id,&body.key,&body.title,&body.reason,&body.prompt,&evidence,&source_conversation_id],
    ).await.map_err(|e| internal_error(format!("failed to submit recommendation: {e}")))?;
    let row = transaction.query_one(
        "select * from space_recommendations where user_id=$1 and project_id=$2 and recommendation_key=$3 for update",
        &[&reader.user_id,&project_id,&body.key],
    ).await.map_err(|e| internal_error(format!("failed to load recommendation: {e}")))?;
    let mut record = map_record(row)?;
    validate_record(&transaction, &reader, &record).await?;
    let mut delivery = None;
    if record.status == RecommendationStatus::Proposed && !record.delivered {
        let row = transaction.query_one(
            "update space_recommendations set title=$2,reason=$3,prompt=$4,evidence=$5,source_conversation_id=$6,updated_at=now() where id=$1 returning *",
            &[&record.id,&body.title,&body.reason,&body.prompt,&evidence,&source_conversation_id],
        ).await.map_err(|e| internal_error(format!("failed to refresh recommendation: {e}")))?;
        record = map_record(row)?;
        if let Some(message) = body.message.as_deref() {
            // Serialize different keys from the same run too. Retries of an
            // already-delivered key return its existing receipt above.
            let run_id: Option<Uuid> = if let Some(job) = reader.active_job.as_ref() {
                let run_id: Uuid = transaction
                    .query_one("select run_id from agent_jobs where id=$1", &[&job.job_id])
                    .await
                    .map_err(|e| internal_error(format!("failed to find review run: {e}")))?
                    .get(0);
                transaction
                    .query_one(
                        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
                        &[&format!("recommendation-delivery:{run_id}")],
                    )
                    .await
                    .map_err(|e| internal_error(format!("failed to lock review delivery: {e}")))?;
                let already_delivered: bool = transaction.query_one(
                    "select exists(select 1 from space_recommendations where delivered_run_id=$1)", &[&run_id],
                ).await.map_err(|e| internal_error(format!("failed to check review delivery: {e}")))?.get(0);
                if already_delivered {
                    return Err((StatusCode::CONFLICT, Json(ApiError::new("This review run has already opened a conversation. Save other findings for a later review."))));
                }
                Some(run_id)
            } else {
                None
            };
            let conversation_id =
                create_private_root(&transaction, &project_id, &reader.user_id, &record.title)
                    .await?;
            // Owner-private storage still uses the owner's created_by. Mark
            // unsolicited delivery so clients never attach it to a local draft.
            transaction.execute(
                "update conversations set metadata=metadata || jsonb_build_object('recommendationId',$2::text) where id=$1",
                &[&conversation_id,&record.id.to_string()],
            ).await.map_err(|e| internal_error(format!("failed to mark proactive conversation: {e}")))?;
            let content = message_with_evidence(
                &transaction,
                &reader,
                &project_id,
                message,
                &record.evidence,
            )
            .await?;
            let message_row = crate::agent::record_agent_conversation_message(
                &transaction,
                &project_id,
                &conversation_id,
                None,
                None,
                None,
                content,
                serde_json::json!({"source":"agent", "agent":{"handle":"octo","displayName":"Octo"}, "recommendationId":record.id}),
            )
            .await?;
            let row = transaction.query_one(
                "update space_recommendations set delivered_conversation_id=$2, delivered_message_id=$3, delivered_run_id=$4, delivered_at=now(), updated_at=now() where id=$1 returning *",
                &[&record.id,&conversation_id,&message_row.id,&run_id],
            ).await.map_err(|e| internal_error(format!("failed to record recommendation delivery: {e}")))?;
            record = map_record(row)?;
            delivery = Some((
                conversation_id,
                conversation_event_payload(&transaction, &conversation_id).await?,
                message_row,
            ));
        }
    }
    redact_continuation(&transaction, &reader, &mut record).await?;
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(format!("failed to commit recommendation: {e}")))?;
    if let Some((conversation_id, payload, message)) = delivery {
        crate::publish_controller_event_with_conversation(
            &state.events,
            "conversation.created",
            Some(project_id),
            None,
            Some(conversation_id),
            None,
            None,
            payload,
        );
        crate::conversations::publish_conversation_message_event(&state.events, &message);
    }
    Ok(Json(record))
}

fn source_chat_label(metadata: Option<&serde_json::Value>) -> String {
    let title = metadata
        .and_then(|value| value.get("title"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut label = String::new();
    for ch in title.chars().filter(|ch| !ch.is_control()).take(160) {
        // The chat-reference dialect treats its label as plain text and has
        // no escape/entity decoding. Break every closing delimiter, including
        // overlapping runs such as ]]], so a title cannot inject another token.
        if ch == ']' && label.ends_with(']') {
            label.push(' ');
        }
        label.push(ch);
    }
    let label = label.trim();
    if label.is_empty() {
        "Source chat".to_owned()
    } else if label.ends_with(']') {
        // Separate a final title bracket from the token's closing brackets;
        // the frontend trims this padding from the displayed label.
        format!("{label} ")
    } else {
        label.to_owned()
    }
}

async fn message_with_evidence(
    transaction: &Transaction<'_>,
    reader: &Reader,
    project_id: &Uuid,
    message: &str,
    evidence: &[Evidence],
) -> ApiResult<String> {
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for entry in evidence {
        if !seen.insert(entry.conversation_id) {
            continue;
        }
        // Resolve the label from the authorized source itself, never from the
        // model's suggested title. Exact message evidence stays on the record.
        let source =
            validate_conversation(transaction, reader, project_id, &entry.conversation_id).await?;
        let label = source_chat_label(source.metadata.as_ref());
        sources.push(format!("[[conversation:{}|{label}]]", source.id));
    }
    Ok(format!("{message}\n\n{}", sources.join(" · ")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewConversation {
    conversation_id: Uuid,
}

fn unavailable_prepared_chat() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::new(
            "The prepared conversation is unavailable or no longer private to you.",
        )),
    )
}

pub(crate) async fn validate_private_root(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    user_id: &Uuid,
    conversation_id: &Uuid,
) -> ApiResult<ConversationRecord> {
    // The row lock also prevents new participant references being inserted
    // while this request verifies and returns the existing private draft.
    if transaction
        .query_opt(
            "select id from conversations where id=$1 for update",
            &[conversation_id],
        )
        .await
        .map_err(|e| internal_error(format!("failed to lock prepared conversation: {e}")))?
        .is_none()
    {
        return Err(unavailable_prepared_chat());
    }
    let conversation = load_conversation_record(transaction, conversation_id).await?;
    let has_other_participants: bool = transaction.query_one(
        "select exists(select 1 from conversation_participants where conversation_id=$1 and user_id<>$2)",
        &[conversation_id, user_id],
    ).await.map_err(|e| internal_error(format!("failed to verify prepared participants: {e}")))?.get(0);
    if conversation.project_id != *project_id
        || conversation.created_by != Some(*user_id)
        || conversation.visibility != "private"
        || conversation.parent_conversation_id.is_some()
        || conversation.root_conversation_id != Some(*conversation_id)
        || has_other_participants
    {
        return Err(unavailable_prepared_chat());
    }
    Ok(conversation)
}

pub(crate) async fn create_private_root(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    user_id: &Uuid,
    title: &str,
) -> ApiResult<Uuid> {
    let conversation_id = Uuid::new_v4();
    let metadata = PgJson(serde_json::json!({"title":title,"visibility":"private"}));
    transaction.execute(
        "insert into conversations(id,project_id,created_by,metadata,visibility,root_conversation_id) values($1,$2,$3,$4,'private',$1)",
        &[&conversation_id,project_id,user_id,&metadata],
    ).await.map_err(|e| internal_error(format!("failed to create prepared conversation: {e}")))?;
    transaction.execute(
        "insert into conversation_participants(conversation_id,user_id,role,added_by) values($1,$2,'owner',$2)",
        &[&conversation_id,user_id],
    ).await.map_err(|e| internal_error(format!("failed to add prepared conversation owner: {e}")))?;
    crate::activity::record_conversation_created_raw(
        transaction,
        project_id,
        &conversation_id,
        Some(*user_id),
        Some(title),
        None,
    )
    .await;
    Ok(conversation_id)
}

pub(crate) async fn conversation_event_payload(
    transaction: &Transaction<'_>,
    conversation_id: &Uuid,
) -> ApiResult<serde_json::Value> {
    let conversation = load_conversation_record(transaction, conversation_id).await?;
    Ok(serde_json::json!({
        "conversationId": conversation.id, "projectId": conversation.project_id,
        "sessionId": conversation.session_id, "createdBy": conversation.created_by,
        "metadata": conversation.metadata.unwrap_or_else(|| serde_json::json!({})),
        "visibility": conversation.visibility, "parentConversationId": conversation.parent_conversation_id,
        "rootConversationId": conversation.root_conversation_id, "threadKind": conversation.thread_kind,
        "lastMessageId": conversation.last_message_id,
        "lastMessageAt": conversation.last_message_at.map(|value| value.to_rfc3339()),
        "lastMessagePreview": conversation.last_message_preview,
        "createdAt": conversation.created_at.to_rfc3339(), "updatedAt": conversation.updated_at.to_rfc3339(),
    }))
}

async fn prepare_action_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, recommendation_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<ReviewConversation>> {
    let context = authenticate_request(&state.config, &headers).await?;
    require_user_session(&context)?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("failed to get connection: {e}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("failed to start transaction: {e}")))?;
    let reader = authorize(
        &transaction,
        &state,
        context,
        &project_id,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    let row = transaction.query_opt(
        "select * from space_recommendations where id=$1 and project_id=$2 and user_id=$3 for update",
        &[&recommendation_id,&project_id,&reader.user_id],
    ).await.map_err(|e| internal_error(format!("failed to load recommendation: {e}")))?
        .ok_or_else(|| not_found("recommendation not found"))?;
    let record = map_record(row)?;
    validate_record(&transaction, &reader, &record).await?;
    if record.status != RecommendationStatus::Proposed {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("This recommendation already has a decision.")),
        ));
    }
    let (conversation_id, event) = if let Some(conversation_id) = record
        .delivered_conversation_id
        .or(record.prepared_conversation_id)
    {
        let conversation =
            validate_private_root(&transaction, &project_id, &reader.user_id, &conversation_id)
                .await
                .map_err(|(status, error)| {
                    if status == StatusCode::CONFLICT {
                        (StatusCode::FORBIDDEN, error)
                    } else {
                        (status, error)
                    }
                })?;
        let lifecycle_key = format!("instafy_conversation_lifecycle_v1_{}", reader.user_id);
        let lifecycle = conversation
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&lifecycle_key));
        let lifecycle_status = lifecycle.and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("status").and_then(serde_json::Value::as_str))
        });
        if lifecycle_status.is_some_and(|status| status.trim().eq_ignore_ascii_case("deleted")) {
            return Err((StatusCode::FORBIDDEN, unavailable_prepared_chat().1));
        }
        (conversation_id, None)
    } else {
        let conversation_id =
            create_private_root(&transaction, &project_id, &reader.user_id, &record.title).await?;
        transaction
            .execute(
                "update space_recommendations set prepared_conversation_id=$2 where id=$1",
                &[&recommendation_id, &conversation_id],
            )
            .await
            .map_err(|e| internal_error(format!("failed to save prepared conversation: {e}")))?;
        (
            conversation_id,
            Some(conversation_event_payload(&transaction, &conversation_id).await?),
        )
    };
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(format!("failed to commit prepared conversation: {e}")))?;
    if let Some(payload) = event {
        crate::publish_controller_event_with_conversation(
            &state.events,
            "conversation.created",
            Some(project_id),
            None,
            Some(conversation_id),
            None,
            None,
            payload,
        );
    }
    Ok(Json(ReviewConversation { conversation_id }))
}

async fn prepare_review_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<ReviewConversation>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("failed to get connection: {e}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("failed to start transaction: {e}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, None).await?;
    // Serialize first creation without touching other spaces or reserving an
    // agent run. Hash collisions only serialize otherwise unrelated requests.
    transaction.query_one(
        "select pg_advisory_xact_lock(hashtextextended('space-review:' || $1::uuid::text || ':' || $2::uuid::text, 0))",
        &[&user_id, &project_id],
    ).await.map_err(|e| internal_error(format!("failed to lock review conversation: {e}")))?;
    let existing = transaction.query_opt(
        "select conversation_id from space_review_conversations where user_id=$1 and project_id=$2",
        &[&user_id, &project_id],
    ).await.map_err(|e| internal_error(format!("failed to load review conversation: {e}")))?;
    let mut event_type = None;
    let conversation_id = if let Some(row) = existing {
        let conversation_id = row.get::<_, Uuid>("conversation_id");
        let conversation =
            validate_private_root(&transaction, &project_id, &user_id, &conversation_id).await?;
        // Preparing another review explicitly reopens this user's archived or
        // hidden chat. Keep all other per-user metadata intact, including when
        // the browser has not loaded this conversation yet.
        let lifecycle_key = format!("instafy_conversation_lifecycle_v1_{user_id}");
        let lifecycle = conversation
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&lifecycle_key));
        let lifecycle_status = lifecycle.and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("status").and_then(serde_json::Value::as_str))
        });
        if lifecycle_status.is_some_and(|status| {
            matches!(
                status.trim().to_ascii_lowercase().as_str(),
                "archived" | "hidden" | "deleted"
            )
        }) {
            transaction.execute(
                "update conversations set metadata=metadata || jsonb_build_object($2::text, jsonb_build_object('status','active','updatedAt',$3::text)), updated_at=now() where id=$1",
                &[&conversation_id, &lifecycle_key, &Utc::now().to_rfc3339()],
            ).await.map_err(|e| internal_error(format!("failed to reopen review conversation: {e}")))?;
            event_type = Some("conversation.updated");
        }
        conversation_id
    } else {
        let conversation_id =
            create_private_root(&transaction, &project_id, &user_id, "Space review").await?;
        transaction.execute(
            "insert into space_review_conversations(user_id,project_id,conversation_id) values($1,$2,$3)",
            &[&user_id,&project_id,&conversation_id],
        ).await.map_err(|e| internal_error(format!("failed to save review conversation: {e}")))?;
        event_type = Some("conversation.created");
        conversation_id
    };
    let event = if let Some(event_type) = event_type {
        Some((
            event_type,
            conversation_event_payload(&transaction, &conversation_id).await?,
        ))
    } else {
        None
    };
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(format!("failed to commit review conversation: {e}")))?;
    if let Some((event_type, payload)) = event {
        crate::publish_controller_event_with_conversation(
            &state.events,
            event_type,
            Some(project_id),
            None,
            Some(conversation_id),
            None,
            None,
            payload,
        );
    }
    Ok(Json(ReviewConversation { conversation_id }))
}

async fn decide_recommendation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, recommendation_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<DecideRecommendation>,
) -> ApiResult<Json<Recommendation>> {
    let context = authenticate_request(&state.config, &headers).await?;
    require_user_session(&context)?;
    if body.status == RecommendationStatus::Proposed {
        return Err(bad_request(
            "a recommendation decision must be accepted or dismissed",
        ));
    }
    if body.status != RecommendationStatus::Accepted && body.accepted_conversation_id.is_some() {
        return Err(bad_request(
            "acceptedConversationId requires accepted status",
        ));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("failed to get connection: {e}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("failed to start transaction: {e}")))?;
    let reader = authorize(
        &transaction,
        &state,
        context,
        &project_id,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    let row = transaction.query_opt(
        "select * from space_recommendations where id=$1 and project_id=$2 and user_id=$3 for update",
        &[&recommendation_id,&project_id,&reader.user_id],
    ).await.map_err(|e| internal_error(format!("failed to load recommendation: {e}")))?
        .ok_or_else(|| not_found("recommendation not found"))?;
    let mut record = map_record(row)?;
    validate_record(&transaction, &reader, &record).await?;
    if let Some(conversation_id) = body.accepted_conversation_id {
        validate_conversation(&transaction, &reader, &project_id, &conversation_id).await?;
    }
    if record.status != RecommendationStatus::Proposed && record.status != body.status {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("This recommendation already has a decision.")),
        ));
    }
    if record.status == RecommendationStatus::Proposed {
        record = map_record(transaction.query_one(
            "update space_recommendations set status=$2,accepted_conversation_id=$3,remind_at=null,reminder_timezone=null,updated_at=now() where id=$1 returning *",
            &[&recommendation_id,&body.status.as_str(),&body.accepted_conversation_id],
        ).await.map_err(|e| internal_error(format!("failed to save recommendation decision: {e}")))?)?;
    }
    redact_continuation(&transaction, &reader, &mut record).await?;
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(format!("failed to commit recommendation decision: {e}")))?;
    Ok(Json(record))
}

#[cfg(test)]
#[path = "recommendations_tests.rs"]
mod tests;
