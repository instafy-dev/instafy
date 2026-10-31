//! Deferred questions from tracked workers. The controller owns the recipient and
//! worker binding; clients answer a request ID, never a caller-selected agent.

use std::collections::{BTreeMap, HashSet};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::agent::{
    ensure_agent_token_matches_runtime_lease_for_job, extract_agent_token,
    record_agent_conversation_message, verify_agent_token_with_scopes,
};
use crate::auth::{authenticate_request, RequestContext};
use crate::conversations::{
    ensure_conversation_access, load_conversation_record, map_conversation_message_row,
    publish_conversation_message_event,
};
use crate::{bad_request, forbidden, internal_error, not_found, ApiError, AppState};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;
pub(crate) type Answers = BTreeMap<String, Vec<String>>;
pub(crate) mod routing;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuestionOption {
    pub(crate) label: String,
    pub(crate) description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Question {
    pub(crate) id: String,
    pub(crate) header: String,
    pub(crate) question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) options: Option<Vec<QuestionOption>>,
    #[serde(default)]
    pub(crate) is_other: bool,
    #[serde(default)]
    pub(crate) is_secret: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    runtime_id: Uuid,
    questions: Vec<Question>,
    continuation_note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnswerRequest {
    answers: Answers,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestView {
    request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<Uuid>,
    status: String,
    questions: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    answers: Option<Value>,
    agent_handle: String,
    can_answer: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    expired_reason: Option<String>,
}

fn view(row: &tokio_postgres::Row) -> RequestView {
    RequestView {
        request_id: row.get("id"),
        message_id: row.get("message_id"),
        status: row.get("status"),
        questions: row.get::<_, PgJson<Value>>("questions").0,
        answers: row.get::<_, Option<PgJson<Value>>>("answers").map(|v| v.0),
        agent_handle: row.get("agent_handle"),
        can_answer: false,
        expired_reason: row.get("expired_reason"),
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/agent/jobs/:job_id/user-input-requests",
            post(create_request),
        )
        .route(
            "/agent/jobs/:job_id/user-input-replies",
            post(routing::apply_reply),
        )
        .route("/user-input-requests/:request_id", get(read_request))
        .route(
            "/user-input-requests/:request_id/answer",
            post(answer_request),
        )
}

fn conflict(message: &str) -> (StatusCode, Json<ApiError>) {
    let (_, error) = bad_request(message);
    (StatusCode::CONFLICT, error)
}

fn bounded(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= maximum && !value.contains('\0')
}

/// The asking worker as its question message names it: its handle, and the
/// saved agent, name and face its job carries, so the question wears its lane's
/// face in the chat and on Home, and a saved agent's face as its profile has it.
fn question_agent(payload: &Value, handle: &str) -> Value {
    let mut agent = json!({ "handle": handle });
    for key in ["id", "displayName", "avatarSeed"] {
        if let Some(value) = payload
            .pointer(&format!("/metadata/agent/{key}"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            agent[key] = json!(value);
        }
    }
    agent
}

pub(crate) fn validate_questions(questions: &[Question], note: &str) -> ApiResult<()> {
    if !(1..=3).contains(&questions.len()) || !bounded(note, 4_000) {
        return Err(bad_request(
            "provide 1–3 questions and a continuationNote of 1–4000 characters",
        ));
    }
    let mut ids = HashSet::new();
    for q in questions {
        if !bounded(&q.id, 100)
            || q.id.trim() != q.id
            || !ids.insert(&q.id)
            || !bounded(&q.header, 100)
            || !bounded(&q.question, 2_000)
        {
            return Err(bad_request(
                "questions need unique IDs and bounded, nonempty headers and text",
            ));
        }
        if q.is_secret {
            return Err(bad_request(
                "secret input is unsupported; use the credential request flow",
            ));
        }
        if let Some(options) = &q.options {
            let mut labels = HashSet::new();
            if !(1..=6).contains(&options.len())
                || options.iter().any(|option| {
                    !bounded(&option.label, 200)
                        || option.description.chars().count() > 1_000
                        || option.description.contains('\0')
                        || !labels.insert(&option.label)
                })
            {
                return Err(bad_request(
                    "question options must have 1–6 distinct bounded labels",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_answers(questions: &[Question], answers: &Answers) -> ApiResult<()> {
    if answers.len() != questions.len()
        || questions.iter().any(|q| {
            let Some(values) = answers.get(&q.id) else {
                return true;
            };
            values.len() != 1 || !bounded(&values[0], 4_000)
        })
    {
        return Err(bad_request(
            "answer each exact question ID once with 1–4000 characters",
        ));
    }
    // Free text remains valid even when suggested choices were supplied.
    Ok(())
}

async fn create_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(body): Json<CreateRequest>,
) -> ApiResult<Json<RequestView>> {
    validate_questions(&body.questions, &body.continuation_note)?;
    let claims = verify_agent_token_with_scopes(
        &state.config,
        extract_agent_token(&headers)?,
        &["agent.input"],
    )?;
    if claims.runtime_id != Some(body.runtime_id) {
        return Err(forbidden(
            "question runtime must match the agent credential",
        ));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("question connection: {e}")))?;
    let tx = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("question transaction: {e}")))?;
    ensure_agent_token_matches_runtime_lease_for_job(&state, &tx, &claims, &body.runtime_id)
        .await?;
    // Use the same group-before-job lock order as cancellation and checkpoint
    // dispatch. The authoritative job binding is rechecked under its row lock.
    let group = tx.query_opt(
        "select payload #>> '{metadata,multiAgentPlan,groupId}' from agent_jobs where id=$1 and project_id=$2",
        &[&job_id,&claims.project_id],
    ).await.map_err(|e| internal_error(format!("load question group: {e}")))?
        .and_then(|row| row.get::<_,Option<String>>(0))
        .and_then(|group| Uuid::parse_str(&group).ok())
        .ok_or_else(|| conflict("question source has no tracked worker group"))?;
    crate::multi_agent_plan::lock_plan_group_checkpoint(&tx, &group.to_string()).await?;
    let row = tx.query_opt(
        "select j.project_id,j.conversation_id,j.run_id,j.prompt_id,j.lease_attempts,j.payload,
                coalesce(p.user_id, pp.user_id) as requested_user_id
         from agent_jobs j
         left join prompts p on p.id=j.prompt_id and p.project_id=j.project_id
         left join agent_jobs parent on parent.id::text=j.payload #>> '{metadata,multiAgentPlan,parentJobId}'
              and parent.project_id=j.project_id and parent.conversation_id=j.conversation_id
         left join prompts pp on pp.id=parent.prompt_id and pp.project_id=j.project_id
         where j.id=$1 and j.project_id=$2 and j.leased_by_runtime_id=$3
           and j.status='leased' and j.lease_expires_at>now()
         for update of j",
        &[&job_id,&claims.project_id,&body.runtime_id]).await
        .map_err(|e| internal_error(format!("load question job: {e}")))?
        .ok_or_else(|| conflict("question source job is not currently leased to this runtime"))?;
    let payload = row.get::<_, PgJson<Value>>("payload").0;
    if payload
        .pointer("/metadata/multiAgentPlan/role")
        .and_then(Value::as_str)
        != Some("worker")
    {
        return Err(bad_request(
            "deferred questions require a tracked worker assignment",
        ));
    }
    let group_id = payload
        .pointer("/metadata/multiAgentPlan/groupId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or_else(|| bad_request("worker has no plan group"))?;
    if group_id != group {
        return Err(conflict(
            "worker plan group changed while registering its question",
        ));
    }
    let conversation_id = row
        .get::<_, Option<Uuid>>("conversation_id")
        .ok_or_else(|| bad_request("worker has no owning conversation"))?;
    let requested_user_id = row
        .get::<_, Option<Uuid>>("requested_user_id")
        .ok_or_else(|| bad_request("worker has no human prompt owner"))?;
    let project_id: Uuid = row.get("project_id");
    if crate::multi_agent_plan::plan_group_was_stopped(
        &tx,
        project_id,
        conversation_id,
        &group_id.to_string(),
    )
    .await?
    {
        return Err(conflict("workstream group was stopped"));
    }
    let questions =
        serde_json::to_value(&body.questions).map_err(|e| bad_request(e.to_string()))?;
    if let Some(existing) = tx
        .query_opt(
            "select * from agent_user_input_requests where job_id=$1",
            &[&job_id],
        )
        .await
        .map_err(|e| internal_error(format!("load duplicate question: {e}")))?
    {
        if existing.get::<_, PgJson<Value>>("questions").0 != questions
            || existing.get::<_, String>("continuation_note") != body.continuation_note
            || existing.get::<_, i32>("lease_attempt") != row.get::<_, i32>("lease_attempts")
        {
            return Err(conflict(
                "this worker job already has a different question request",
            ));
        }
        return Ok(Json(view(&existing)));
    }
    let request_id = Uuid::new_v4();
    let handle = payload
        .pointer("/metadata/agent/handle")
        .and_then(Value::as_str)
        .filter(|v| bounded(v, 120))
        .unwrap_or("worker");
    let run_id: Option<Uuid> = row.get("run_id");
    let prompt_id: Option<Uuid> = row.get("prompt_id");
    let lease_attempt: i32 = row.get("lease_attempts");
    let inserted = tx.query_one(
        "insert into agent_user_input_requests(id,project_id,conversation_id,job_id,run_id,prompt_id,
             runtime_id,lease_attempt,group_id,requested_user_id,agent_handle,questions,continuation_note)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *",
        &[&request_id,&project_id,&conversation_id,&job_id,&run_id,&prompt_id,&body.runtime_id,
            &lease_attempt,&group_id,&requested_user_id,&handle,&PgJson(&questions),&body.continuation_note]).await
        .map_err(|e| internal_error(format!("persist worker question: {e}")))?;
    let conversation = load_conversation_record(&tx, &conversation_id).await?;
    let text = body
        .questions
        .iter()
        .map(|q| q.question.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let message = record_agent_conversation_message(
        &tx,
        &project_id,
        &conversation_id,
        conversation.session_id,
        prompt_id,
        run_id,
        text,
        json!({"jobId":job_id,"messageType":"action_request",
            "agent":question_agent(&payload, handle),"details":{"userInputRequestId":request_id,"userInputRequestStatus":"pending"}}),
    )
    .await?;
    tx.execute(
        "update agent_user_input_requests set message_id=$2 where id=$1",
        &[&request_id, &message.id],
    )
    .await
    .map_err(|e| internal_error(format!("bind worker question message: {e}")))?;
    let mut result = view(&inserted);
    result.message_id = Some(message.id);
    tx.commit()
        .await
        .map_err(|e| internal_error(format!("commit worker question: {e}")))?;
    publish_conversation_message_event(&state.events, &message);
    crate::notifications::enqueue_message_push_notifications(state.clone(), message);
    drop(connection);
    publish_request_run_event(&state, request_id).await;
    Ok(Json(result))
}

pub(crate) async fn authorize_human(
    tx: &tokio_postgres::Transaction<'_>,
    context: &RequestContext,
    row: &tokio_postgres::Row,
    write: bool,
) -> ApiResult<()> {
    if context.scoped_claims.is_some() || context.user_id.is_none() || context.is_service_role {
        return Err(forbidden(
            "worker answers require a signed-in human session",
        ));
    }
    let conversation = load_conversation_record(tx, &row.get("conversation_id")).await?;
    let project = crate::load_project_record(tx, &row.get("project_id")).await?;
    if write {
        if row.get::<_, Option<Uuid>>("requested_user_id") != context.user_id {
            return Err(forbidden(
                "only the person who started this work may answer",
            ));
        }
        crate::ensure_project_write_access(tx, &project, context, conversation.session_id).await?;
        crate::dispatch::ensure_project_prompt_access(
            tx,
            &project,
            context,
            conversation.session_id,
        )
        .await?;
    } else {
        crate::projects::ensure_project_read_access(tx, &project, context, conversation.session_id)
            .await?;
    }
    ensure_conversation_access(tx, &conversation, context).await
}

async fn read_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request_id): Path<Uuid>,
) -> ApiResult<Json<RequestView>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("question connection: {e}")))?;
    let tx = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("question transaction: {e}")))?;
    let row = tx
        .query_opt(
            "select * from agent_user_input_requests where id=$1",
            &[&request_id],
        )
        .await
        .map_err(|e| internal_error(format!("load worker question: {e}")))?
        .ok_or_else(|| not_found("worker question not found"))?;
    authorize_human(&tx, &context, &row, false).await?;
    let mut result = view(&row);
    result.can_answer = result.status == "pending"
        && row.get::<_, Option<Uuid>>("requested_user_id") == context.user_id
        && authorize_human(&tx, &context, &row, true).await.is_ok();
    Ok(Json(result))
}

async fn answer_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request_id): Path<Uuid>,
    Json(body): Json<AnswerRequest>,
) -> ApiResult<Json<RequestView>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("answer connection: {e}")))?;
    let tx = connection
        .transaction()
        .await
        .map_err(|e| internal_error(format!("answer transaction: {e}")))?;
    let row = tx
        .query_opt(
            "select * from agent_user_input_requests where id=$1 for update",
            &[&request_id],
        )
        .await
        .map_err(|e| internal_error(format!("load worker answer: {e}")))?
        .ok_or_else(|| not_found("worker question not found"))?;
    authorize_human(&tx, &context, &row, true).await?;
    let questions: Vec<Question> =
        serde_json::from_value(row.get::<_, PgJson<Value>>("questions").0)
            .map_err(|e| internal_error(format!("stored question schema: {e}")))?;
    validate_answers(&questions, &body.answers)?;
    let answers = serde_json::to_value(&body.answers).map_err(|e| bad_request(e.to_string()))?;
    let status: String = row.get("status");
    if status == "expired" {
        return Err(conflict("this worker question is no longer active"));
    }
    if status != "pending" {
        if row.get::<_, Option<PgJson<Value>>>("answers").map(|v| v.0) != Some(answers) {
            return Err(conflict(
                "this worker question already has a different answer",
            ));
        }
        tx.commit()
            .await
            .map_err(|e| internal_error(format!("commit answer replay: {e}")))?;
    } else {
        let project_id: Uuid = row.get("project_id");
        let conversation_id: Uuid = row.get("conversation_id");
        let group_id: Uuid = row.get("group_id");
        let source_is_current: bool = tx.query_one(
            "select exists(select 1 from agent_jobs where id=$1 and project_id=$2 and lease_attempts=$3
             and (status='completed' or (status='leased' and leased_by_runtime_id=$4 and lease_expires_at>now())))",
            &[&row.get::<_,Uuid>("job_id"),&project_id,&row.get::<_,i32>("lease_attempt"),&row.get::<_,Option<Uuid>>("runtime_id")],
        ).await.map_err(|e| internal_error(format!("validate worker answer source: {e}")))?.get(0);
        if !source_is_current {
            tx.execute("update agent_user_input_requests set status='expired',expired_reason='The worker lease or job is no longer active.',updated_at=now() where id=$1",&[&request_id]).await
                .map_err(|e| internal_error(format!("expire stale worker answer: {e}")))?;
            tx.commit()
                .await
                .map_err(|e| internal_error(format!("commit stale worker answer: {e}")))?;
            drop(connection);
            publish_request_run_event(&state, request_id).await;
            return Err(conflict("this worker question is no longer active"));
        }
        if crate::multi_agent_plan::plan_group_was_stopped(
            &tx,
            project_id,
            conversation_id,
            &group_id.to_string(),
        )
        .await?
        {
            return Err(conflict("workstream group was stopped"));
        }
        let conversation = load_conversation_record(&tx, &conversation_id).await?;
        let message_id = Uuid::new_v4();
        let content = questions
            .iter()
            .map(|q| format!("{}: {}", q.header, body.answers[&q.id][0]))
            .collect::<Vec<_>>()
            .join("\n");
        let message_row = tx.query_one(
            "insert into conversation_messages(id,project_id,conversation_id,run_id,prompt_id,role,content,metadata,created_by,session_id)
             values($1,$2,$3,$4,$5,'user',$6,$7,$8,$9)
             returning id,conversation_id,project_id,session_id,created_by,prompt_id,run_id,role,content,metadata,created_at",
            &[&message_id,&project_id,&conversation_id,&row.get::<_,Option<Uuid>>("run_id"),
                &row.get::<_,Option<Uuid>>("prompt_id"),&content,
                &PgJson(json!({"userInputRequestId":request_id})),&context.user_id,&conversation.session_id]).await
            .map_err(|e| internal_error(format!("record worker answer: {e}")))?;
        tx.execute(
            "update agent_user_input_requests set status='answered',answers=$2,answered_by=$3,
            answer_message_id=$4,answered_at=now(),updated_at=now() where id=$1",
            &[
                &request_id,
                &PgJson(&answers),
                &context.user_id,
                &message_id,
            ],
        )
        .await
        .map_err(|e| internal_error(format!("persist worker answer: {e}")))?;
        let preview = crate::conversations::build_conversation_last_message_preview(&content);
        tx.execute(
            "update conversations set updated_at=now(),last_message_id=$2,last_message_at=now(),last_message_preview=$3 where id=$1",
            &[&conversation_id,&message_id,&preview],
        ).await.map_err(|e| internal_error(format!("update worker answer conversation: {e}")))?;
        tx.execute(
            "update conversations set updated_at=now() where id=$1 and id<>$2",
            &[&conversation.root_conversation_id, &conversation_id],
        )
        .await
        .map_err(|e| internal_error(format!("update worker answer root: {e}")))?;
        let message = map_conversation_message_row(&message_row);
        tx.commit()
            .await
            .map_err(|e| internal_error(format!("commit worker answer: {e}")))?;
        publish_conversation_message_event(&state.events, &message);
    }
    // Do not pin a pool connection while the coordinator dispatches the exact worker.
    drop(connection);
    publish_request_run_event(&state, request_id).await;
    crate::multi_agent_plan::user_input::resume_answered_request(&state, request_id).await?;
    read_request(State(state), headers, Path(request_id)).await
}

/// Publish the ordinary run snapshot after a request transition commits. Failure
/// to publish must not turn a durably recorded answer into a client-visible error.
pub(crate) async fn publish_request_run_event(state: &AppState, request_id: Uuid) {
    let result: ApiResult<()> = async {
        let mut connection = state
            .pool
            .get()
            .await
            .map_err(|e| internal_error(format!("question run connection: {e}")))?;
        let rows = connection
            .query(
                "select project_id,job_id,run_id from agent_user_input_requests where id=$1
                 union all select j.project_id,j.id,j.run_id from agent_user_input_requests q
                   join agent_jobs j on j.id=q.resumed_job_id and j.project_id=q.project_id
                 where q.id=$1 and q.status='expired' and j.status='canceled'",
                &[&request_id],
            )
            .await
            .map_err(|e| internal_error(format!("question run lookup: {e}")))?;
        for row in rows {
            let Some(run_id) = row.get::<_, Option<Uuid>>("run_id") else {
                continue;
            };
            let Some(snapshot) = crate::runs::load_run_snapshot(&mut *connection, &run_id).await?
            else {
                continue;
            };
            crate::publish_controller_event_with_conversation(
                &state.events,
                "run.progress",
                Some(row.get("project_id")),
                snapshot.session_id,
                snapshot.conversation_id,
                Some(run_id),
                Some(row.get("job_id")),
                json!({"run":crate::runs::run_snapshot_to_json(&snapshot)}),
            );
        }
        Ok(())
    }
    .await;
    if let Err((_, Json(error))) = result {
        tracing::warn!(%request_id,error=%error.message,"failed to publish worker question state");
    }
}

/// Dispatch can commit just before deletion invalidates the question. Stop
/// only that exact continuation if the request transition lost the race.
pub(crate) async fn cancel_undeliverable_continuation(
    tx: &tokio_postgres::Transaction<'_>,
    request_id: Uuid,
    job_id: Uuid,
) -> ApiResult<()> {
    let row = tx
        .query_opt(
            "select j.id,j.run_id from agent_jobs j join agent_user_input_requests q
           on q.id=$1 and q.project_id=j.project_id and q.conversation_id=j.conversation_id
         where j.id=$2 and q.status='expired' and j.status in ('queued','leased')
           and j.payload #>> '{metadata,multiAgentPlan,userInputContinuation,requestId}'=q.id::text
           and j.payload #>> '{metadata,multiAgentPlan,userInputContinuation,of}'=q.job_id::text
           and coalesce(j.plan_group_id::text,j.payload #>> '{metadata,multiAgentPlan,groupId}')=q.group_id::text
         for update of j",
            &[&request_id, &job_id],
        )
        .await
        .map_err(|e| internal_error(format!("lock undeliverable continuation: {e}")))?;
    let Some(row) = row else {
        return Ok(());
    };
    crate::conversations::cancel_jobs_and_runs(
        tx,
        &[(job_id, row.get::<_, Option<Uuid>>("run_id"))],
        "The worker question was canceled before continuation.",
    )
    .await?;
    tx.execute(
        "update agent_user_input_requests set resumed_job_id=$2 where id=$1 and status='expired'",
        &[&request_id, &job_id],
    )
    .await
    .map_err(|e| internal_error(format!("record canceled continuation: {e}")))?;
    Ok(())
}

/// Expire unanswered work in the same transaction as its authoritative stop.
/// Callers holding a group lock must acquire it before locking worker jobs.
pub(crate) async fn expire_requests(
    tx: &tokio_postgres::Transaction<'_>,
    project_id: Uuid,
    conversation_id: Option<Uuid>,
    group_id: Option<Uuid>,
    reason: &str,
) -> ApiResult<Vec<Uuid>> {
    let reason: String = reason
        .trim()
        .chars()
        .filter(|ch| *ch != '\0')
        .take(2_000)
        .collect();
    let reason = if reason.trim().is_empty() {
        "This work was stopped."
    } else {
        reason.as_str()
    };
    tx.query(
        "update agent_user_input_requests set status='expired',expired_reason=$4,updated_at=now()
         where project_id=$1 and ($2::uuid is null or conversation_id=$2)
           and ($3::uuid is null or group_id=$3) and status in ('pending','answered') returning id",
        &[&project_id, &conversation_id, &group_id, &reason],
    )
    .await
    .map(|rows| rows.iter().map(|row| row.get(0)).collect())
    .map_err(|e| internal_error(format!("expire stopped worker questions: {e}")))
}

#[cfg(test)]
#[path = "user_input_requests_tests.rs"]
mod tests;
