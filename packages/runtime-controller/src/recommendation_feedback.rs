//! A reply can change only the recommendation delivered into that exact private root.
//! This deliberately does not grant access to the originating review's private context.
use super::*;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum FeedbackAction {
    Dismiss {},
    Remind {
        #[serde(rename = "runAt")]
        run_at: String,
        timezone: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Feedback {
    recommendation_id: Uuid,
    conversation_id: Uuid,
    project_id: Uuid,
    title: String,
    status: RecommendationStatus,
    remind_at: Option<String>,
    timezone: Option<String>,
    last_reminded_at: Option<String>,
}

fn as_feedback(record: Recommendation, conversation_id: Uuid) -> Feedback {
    Feedback {
        recommendation_id: record.id,
        conversation_id,
        project_id: record.project_id,
        title: record.title,
        status: record.status,
        remind_at: record.remind_at,
        timezone: record.timezone,
        last_reminded_at: record.last_reminded_at,
    }
}

pub(super) fn router() -> Router<AppState> {
    Router::new().route(
        "/conversations/:conversation_id/recommendation-feedback",
        get(get_feedback).patch(update_feedback),
    )
}

async fn load_feedback(
    transaction: &Transaction<'_>,
    state: &AppState,
    context: RequestContext,
    conversation_id: Uuid,
    access: ActiveJobProjectAccess,
) -> ApiResult<(Reader, Recommendation)> {
    let job = authorize_active_job_if_scoped(transaction, state, &context, access).await?;
    let user_id = match job.as_ref() {
        Some(job) => {
            if job.conversation_id != conversation_id {
                return Err(crate::forbidden(
                    "feedback requires the job's exact conversation",
                ));
            }
            job.subject_user_id
        }
        None => require_user_session(&context)?,
    };
    // Lock the topic before its conversation, matching the delivery worker.
    let row = transaction.query_opt(
        "select * from space_recommendations where delivered_conversation_id=$1 and user_id=$2 for update",
        &[&conversation_id, &user_id],
    ).await.map_err(|e| internal_error(format!("failed to load recommendation feedback: {e}")))?
        .ok_or_else(|| not_found("this conversation has no recommendation feedback"))?;
    let record = map_record(row)?;
    let reader = authorize(transaction, state, context, &record.project_id, access).await?;
    validate_private_root(transaction, &record.project_id, &user_id, &conversation_id).await?;
    Ok((reader, record))
}

fn is_active(conversation: &ConversationRecord, user_id: Uuid) -> bool {
    let key = format!("instafy_conversation_lifecycle_v1_{user_id}");
    let lifecycle = conversation
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(&key));
    let status = lifecycle.and_then(|value| {
        value
            .as_str()
            .or_else(|| value.get("status").and_then(|value| value.as_str()))
    });
    !matches!(
        status
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("archived" | "hidden" | "deleted")
    )
}

async fn get_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<Uuid>,
) -> ApiResult<Json<Feedback>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(e.to_string()))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(e.to_string()))?;
    let (_, record) = load_feedback(
        &transaction,
        &state,
        context,
        conversation_id,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(e.to_string()))?;
    Ok(Json(as_feedback(record, conversation_id)))
}

async fn update_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<Uuid>,
    Json(action): Json<FeedbackAction>,
) -> ApiResult<Json<Feedback>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(e.to_string()))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|e| internal_error(e.to_string()))?;
    let (reader, record) = load_feedback(
        &transaction,
        &state,
        context,
        conversation_id,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    let (status, remind_at, timezone) = match action {
        FeedbackAction::Dismiss {} => ("dismissed", None, None),
        FeedbackAction::Remind { run_at, timezone } => {
            let timezone = timezone.trim().to_owned();
            let run_at = crate::automations::parse_run_at(&run_at, &timezone)?;
            if run_at <= Utc::now() {
                return Err(bad_request("runAt must be in the future"));
            }
            let conversation = validate_private_root(
                &transaction,
                &record.project_id,
                &reader.user_id,
                &conversation_id,
            )
            .await?;
            if !is_active(&conversation, reader.user_id) {
                return Err(bad_request(
                    "restore this conversation before scheduling a reminder",
                ));
            }
            // Only the controller checks the owner's evidence access. The reply
            // job stays in its delivered root and receives no source content or
            // identifiers; a private source in another root must not prevent a
            // reminder about the topic already delivered here. Do not inherit
            // service authority when verifying the owner's current access.
            let owner = authorize(
                &transaction,
                &state,
                RequestContext {
                    user_id: Some(reader.user_id),
                    is_service_role: false,
                    scoped_claims: None,
                },
                &record.project_id,
                ActiveJobProjectAccess::Write,
            )
            .await?;
            validate_evidence(&transaction, &owner, &record.project_id, &record.evidence).await?;
            ("proposed", Some(run_at), Some(timezone))
        }
    };
    let row = transaction.query_one(
        "update space_recommendations set status=$2,accepted_conversation_id=null,remind_at=$3,reminder_timezone=$4,updated_at=now() where id=$1 returning *",
        &[&record.id, &status, &remind_at, &timezone],
    ).await.map_err(|e| internal_error(format!("failed to save reminder preference: {e}")))?;
    let feedback = as_feedback(map_record(row)?, conversation_id);
    transaction
        .commit()
        .await
        .map_err(|e| internal_error(e.to_string()))?;
    Ok(Json(feedback))
}

fn worker_error((status, error): (StatusCode, Json<ApiError>)) -> anyhow::Error {
    anyhow::anyhow!("{status}: {}", error.0.message)
}

/// Scheduler-owned delivery: no runtime, prompt execution, or new conversation.
pub(crate) async fn deliver_due_reminders(state: &AppState) -> anyhow::Result<usize> {
    let mut delivered = 0;
    for _ in 0..25 {
        let mut connection = state.pool.get().await?;
        let transaction = connection.transaction().await?;
        let Some(row) = transaction.query_opt(
            "select * from space_recommendations where remind_at <= now() order by remind_at,id limit 1 for update skip locked", &[],
        ).await? else { break };
        let user_id: Uuid = row.get("user_id");
        let record = map_record(row).map_err(worker_error)?;
        let conversation_id = record
            .delivered_conversation_id
            .ok_or_else(|| anyhow::anyhow!("reminder has no delivered conversation"))?;
        let validation: ApiResult<Reader> = async {
            let context = RequestContext {
                user_id: Some(user_id),
                is_service_role: false,
                scoped_claims: None,
            };
            let reader = authorize(
                &transaction,
                state,
                context,
                &record.project_id,
                ActiveJobProjectAccess::Write,
            )
            .await?;
            let conversation =
                validate_private_root(&transaction, &record.project_id, &user_id, &conversation_id)
                    .await?;
            if !is_active(&conversation, user_id) || record.status != RecommendationStatus::Proposed
            {
                return Err(not_found("reminder conversation is no longer active"));
            }
            validate_evidence(&transaction, &reader, &record.project_id, &record.evidence).await?;
            Ok(reader)
        }
        .await;
        let reader = match validation {
            Ok(reader) => reader,
            Err((
                StatusCode::FORBIDDEN
                | StatusCode::NOT_FOUND
                | StatusCode::CONFLICT
                | StatusCode::UNAUTHORIZED,
                _,
            )) => {
                // Never reopen or relocate a reminder after access/lifecycle changes.
                transaction.execute("update space_recommendations set remind_at=null,reminder_timezone=null,updated_at=now() where id=$1", &[&record.id]).await?;
                transaction.commit().await?;
                continue;
            }
            Err(error) => return Err(worker_error(error)),
        };
        let content = message_with_evidence(
            &transaction,
            &reader,
            &record.project_id,
            &format!(
                "You asked me to remind you about {}. We can pick it up here.",
                record.title
            ),
            &record.evidence,
        )
        .await
        .map_err(worker_error)?;
        let message = crate::agent::record_agent_conversation_message(
            &transaction, &record.project_id, &conversation_id, None, None, None, content,
            serde_json::json!({"source":"agent","agent":{"handle":"octo","displayName":"Octo"},"recommendationId":record.id,"recommendationReminder":true}),
        ).await.map_err(worker_error)?;
        transaction.execute("update space_recommendations set remind_at=null,reminder_timezone=null,last_reminded_at=now(),updated_at=now() where id=$1", &[&record.id]).await?;
        transaction.commit().await?;
        crate::conversations::publish_conversation_message_event(&state.events, &message);
        delivered += 1;
    }
    Ok(delivered)
}
