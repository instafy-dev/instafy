//! Natural replies only interpret an authenticated, stored human message. The
//! model selects exact excerpts; this controller owns recipients and mutations.
use super::*;

const MAX_REQUESTS: usize = 8;
const MAX_SOURCES: usize = 4;
const MAX_SOURCE_CHARS: usize = 8_000;
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    message_id: Uuid,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    request_id: Uuid,
    message_id: Option<Uuid>,
    agent_handle: String,
    task_label: Option<String>,
    questions: Vec<Question>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    current_message_id: Uuid,
    requests: Vec<Pending>,
    sources: Vec<Source>,
    truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remaining_request: Option<Excerpt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    clarification_request_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Excerpt {
    source_message_id: Uuid,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnswerExcerpt {
    request_id: Uuid,
    question_id: String,
    source_message_id: Uuid,
    value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReplyRequest {
    runtime_id: Uuid,
    disposition: String,
    #[serde(default)]
    answers: Vec<AnswerExcerpt>,
    clarification: Option<String>,
    remaining_request: Option<Excerpt>,
}

/// Neither recorded messages nor dispatch metadata may manufacture authority,
/// even through nested metadata that a later job might promote.
pub(crate) fn strip_claims(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in [
                "workerInputRouting",
                "worker_input_routing",
                "workerInputReplyReceipt",
                "worker_input_reply_receipt",
            ] {
                map.remove(key);
            }
            for value in map.values_mut() {
                strip_claims(value);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(strip_claims),
        _ => {}
    }
}

fn source_contains(snapshot: &Snapshot, message_id: Uuid, text: &str, maximum: usize) -> bool {
    bounded(text, maximum)
        && snapshot
            .sources
            .iter()
            .any(|source| source.message_id == message_id && source.text.contains(text))
}

fn validate_reply(snapshot: &Snapshot, reply: &ReplyRequest) -> ApiResult<BTreeMap<Uuid, Answers>> {
    if snapshot.remaining_request.is_some() && reply.remaining_request != snapshot.remaining_request
    {
        return Err(bad_request(
            "carry the separate remaining request unchanged until it can run",
        ));
    }
    if let Some(remainder) = &reply.remaining_request {
        if !source_contains(
            snapshot,
            remainder.source_message_id,
            &remainder.text,
            MAX_SOURCE_CHARS,
        ) {
            return Err(bad_request(
                "remainingRequest must quote an exact supplied human message excerpt",
            ));
        }
    }
    if reply.disposition == "clarify" {
        if !reply.answers.is_empty()
            || !reply
                .clarification
                .as_deref()
                .is_some_and(|text| bounded(text, 2_000))
        {
            return Err(bad_request(
                "clarify requires one question and no proposed answers",
            ));
        }
        return Ok(BTreeMap::new());
    }
    if reply.disposition != "answer"
        || reply.clarification.is_some()
        || snapshot.truncated
        || reply.answers.is_empty()
        || reply.answers.len() > MAX_REQUESTS * 3
    {
        return Err(bad_request(
            "answer requires a complete snapshot and bounded answers, without clarification",
        ));
    }
    let mut grouped = BTreeMap::<Uuid, Answers>::new();
    for answer in &reply.answers {
        if answer.source_message_id != snapshot.current_message_id
            && !snapshot
                .clarification_request_ids
                .contains(&answer.request_id)
        {
            return Err(bad_request(
                "an earlier clarification source cannot answer a different question",
            ));
        }
        if !source_contains(snapshot, answer.source_message_id, &answer.value, 4_000) {
            return Err(bad_request(
                "each answer must quote an exact supplied human message excerpt",
            ));
        }
        let pending = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == answer.request_id)
            .ok_or_else(|| bad_request("answer names a question outside this turn's snapshot"))?;
        if !pending
            .questions
            .iter()
            .any(|question| question.id == answer.question_id)
            || grouped
                .entry(answer.request_id)
                .or_default()
                .insert(answer.question_id.clone(), vec![answer.value.clone()])
                .is_some()
        {
            return Err(bad_request(
                "answer question IDs must be exact and distinct",
            ));
        }
    }
    for (request_id, answers) in &grouped {
        let pending = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == *request_id)
            .expect("validated request");
        validate_answers(&pending.questions, answers)?;
    }
    Ok(grouped)
}

async fn human_source(
    tx: &tokio_postgres::Transaction<'_>,
    project_id: Uuid,
    conversation_id: Uuid,
    user_id: Uuid,
    message_id: Uuid,
) -> ApiResult<Source> {
    let row = tx.query_opt(
        "select content from conversation_messages where id=$1 and project_id=$2 and conversation_id=$3 and role='user' and created_by=$4",
        &[&message_id, &project_id, &conversation_id, &user_id],
    ).await.map_err(|error| internal_error(format!("load reply source: {error}")))?
        .ok_or_else(|| forbidden("reply source must be the owning person's message in this chat"))?;
    Ok(Source {
        message_id,
        text: row.get("content"),
    })
}

pub(crate) async fn snapshot(
    tx: &tokio_postgres::Transaction<'_>,
    context: &RequestContext,
    project_id: Uuid,
    conversation_id: Uuid,
    message_id: Uuid,
) -> ApiResult<Option<Value>> {
    let Some(user_id) = context
        .user_id
        .filter(|_| !context.is_service_role && context.scoped_claims.is_none())
    else {
        return Ok(None);
    };
    let current = human_source(tx, project_id, conversation_id, user_id, message_id).await?;
    let rows = tx.query(
        "select q.*,j.payload from agent_user_input_requests q join agent_jobs j on j.id=q.job_id
         where q.project_id=$1 and q.conversation_id=$2 and q.requested_user_id=$3 and q.status='pending'
           and j.lease_attempts=q.lease_attempt and (j.status='completed' or (j.status='leased' and j.leased_by_runtime_id=q.runtime_id and j.lease_expires_at>now()))
         order by q.created_at,q.id limit 9",
        &[&project_id, &conversation_id, &user_id],
    ).await.map_err(|error| internal_error(format!("load pending reply questions: {error}")))?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut result = Snapshot {
        current_message_id: message_id,
        requests: Vec::new(),
        sources: Vec::new(),
        truncated: rows.len() > MAX_REQUESTS,
        remaining_request: None,
        clarification_request_ids: Vec::new(),
    };
    for row in rows.iter().take(MAX_REQUESTS) {
        authorize_human(tx, context, row, true).await?;
        let handle: String = row.get("agent_handle");
        let payload = row.get::<_, PgJson<Value>>("payload").0;
        let task_label = payload
            .pointer("/plan_seed/agents")
            .and_then(Value::as_array)
            .and_then(|agents| {
                agents.iter().find(|agent| {
                    agent.get("handle").and_then(Value::as_str) == Some(handle.as_str())
                })
            })
            .and_then(|agent| agent.get("label"))
            .and_then(Value::as_str)
            .map(str::to_string);
        result.requests.push(Pending {
            request_id: row.get("id"),
            message_id: row.get("message_id"),
            agent_handle: handle,
            task_label,
            questions: serde_json::from_value(row.get::<_, PgJson<Value>>("questions").0)
                .map_err(|error| internal_error(format!("pending question schema: {error}")))?,
        });
    }

    // Carry prior human text only across a real, immediately preceding
    // clarification from its exact routing job. An unposted/late clarification
    // or any intervening conversational message cannot become a reply source.
    let preceding = tx
        .query_opt(
        "select id,content,metadata,created_at,role,created_by,prompt_id,run_id from conversation_messages
         where project_id=$1 and conversation_id=$2 and id<>$3 and role in ('user','assistant')
           and created_at <= (select created_at from conversation_messages where id=$3)
         order by created_at desc,id desc limit 1",
            &[&project_id, &conversation_id, &message_id],
        )
        .await
        .map_err(|error| internal_error(format!("load reply clarification: {error}")))?;
    if let Some(previous) = preceding.filter(|row| {
        row.get::<_, String>("role") == "assistant"
            && row.get::<_, Option<Uuid>>("created_by").is_none()
    }) {
        let metadata = previous
            .get::<_, Option<PgJson<Value>>>("metadata")
            .map(|value| value.0)
            .unwrap_or(Value::Null);
        if let Some(job_id) = metadata
            .get("jobId")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
        {
            if let Some(row) = tx.query_opt(
                "select payload #> '{metadata,workerInputReplyReceipt}' as receipt from agent_jobs where id=$1 and project_id=$2 and conversation_id=$3 and prompt_id=$4 and run_id=$5",
                &[&job_id,&project_id,&conversation_id,&previous.get::<_,Option<Uuid>>("prompt_id"),&previous.get::<_,Option<Uuid>>("run_id")],
            ).await.map_err(|error| internal_error(format!("load clarification receipt: {error}")))? {
                let receipt = row.get::<_, Option<PgJson<Value>>>("receipt").map(|value| value.0).unwrap_or(Value::Null);
                let previous_text: String = previous.get("content");
                let previous_time: chrono::DateTime<chrono::Utc> = previous.get("created_at");
                let prior_current = receipt.get("currentMessageId").and_then(Value::as_str).and_then(|value| Uuid::parse_str(value).ok());
                let nearest_human = tx.query_opt(
                    "select id from conversation_messages where project_id=$1 and conversation_id=$2 and role='user' and created_at<=$3 and id<>$4 order by created_at desc,id desc limit 1",
                    &[&project_id,&conversation_id,&previous_time,&message_id],
                ).await.map_err(|error| internal_error(format!("validate clarification adjacency: {error}")))?.map(|row| row.get::<_,Uuid>("id"));
                if receipt.pointer("/decision/disposition").and_then(Value::as_str) == Some("clarify")
                    && receipt.pointer("/decision/clarification").and_then(Value::as_str) == Some(previous_text.as_str())
                    && prior_current.is_some() && prior_current == nearest_human
                    && receipt.get("requestedUserId").and_then(Value::as_str) == Some(user_id.to_string().as_str())
                {
                    let old_sources: Vec<Source> = serde_json::from_value(receipt.get("sources").cloned().unwrap_or(Value::Null)).unwrap_or_default();
                    for source in old_sources {
                        if result.sources.len() >= MAX_SOURCES - 1 { result.truncated = true; break; }
                        if let Ok(authoritative) = human_source(tx, project_id, conversation_id, user_id, source.message_id).await {
                            if source.text == authoritative.text && source.text.chars().count() <= MAX_SOURCE_CHARS {
                                result.sources.push(source);
                            }
                        }
                    }
                    result.remaining_request = receipt.pointer("/decision/remainingRequest").cloned().and_then(|value| serde_json::from_value(value).ok());
                    result.clarification_request_ids = serde_json::from_value(receipt.get("requestIds").cloned().unwrap_or(Value::Null)).unwrap_or_default();
                    result.clarification_request_ids.retain(|id| result.requests.iter().any(|request| request.request_id == *id));
                }
            }
        }
    }
    if current.text.chars().count() > MAX_SOURCE_CHARS {
        result.truncated = true;
    }
    result.sources.push(Source {
        message_id,
        text: current.text.chars().take(MAX_SOURCE_CHARS).collect(),
    });
    while serde_json::to_vec(&result)
        .map_err(|error| internal_error(error.to_string()))?
        .len()
        > MAX_SNAPSHOT_BYTES
    {
        result.truncated = true;
        if result.requests.pop().is_none() {
            return Ok(None);
        }
    }
    if result.requests.is_empty() {
        return Ok(None);
    }
    serde_json::to_value(result)
        .map(Some)
        .map_err(|error| internal_error(error.to_string()))
}

pub(super) async fn apply_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(mut body): Json<ReplyRequest>,
) -> ApiResult<Json<Value>> {
    let claims = verify_agent_token_with_scopes(
        &state.config,
        extract_agent_token(&headers)?,
        &["agent.input"],
    )?;
    if claims.runtime_id != Some(body.runtime_id) {
        return Err(forbidden("reply runtime must match its agent credential"));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("reply connection: {error}")))?;
    let tx = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("reply transaction: {error}")))?;
    ensure_agent_token_matches_runtime_lease_for_job(&state, &tx, &claims, &body.runtime_id)
        .await?;
    let job = tx.query_opt(
        "select j.payload,j.prompt_id,j.conversation_id,p.user_id from agent_jobs j join prompts p on p.id=j.prompt_id and p.project_id=j.project_id
         where j.id=$1 and j.project_id=$2 and j.status='leased' and j.leased_by_runtime_id=$3 and j.lease_expires_at>now()",
        &[&job_id,&claims.project_id,&body.runtime_id],
    ).await.map_err(|error| internal_error(format!("load routing job: {error}")))?
        .ok_or_else(|| conflict("reply routing job is no longer leased to this runtime"))?;
    let payload = job.get::<_, PgJson<Value>>("payload").0;
    let issued = payload
        .pointer("/metadata/workerInputRouting")
        .cloned()
        .ok_or_else(|| forbidden("this job has no controller-issued worker question context"))?;
    let snapshot: Snapshot = serde_json::from_value(issued.clone())
        .map_err(|_| forbidden("invalid controller question context"))?;
    let grouped = validate_reply(&snapshot, &body)?;
    let user_id = job
        .get::<_, Option<Uuid>>("user_id")
        .ok_or_else(|| forbidden("routing job has no human owner"))?;
    let conversation_id = job
        .get::<_, Option<Uuid>>("conversation_id")
        .ok_or_else(|| forbidden("routing job has no owning chat"))?;
    let prompt_id: Uuid = job.get("prompt_id");
    let current = tx.query_opt(
        "select id from conversation_messages where id=$1 and project_id=$2 and conversation_id=$3 and role='user' and created_by=$4 and prompt_id=$5",
        &[&snapshot.current_message_id,&claims.project_id,&conversation_id,&user_id,&prompt_id],
    ).await.map_err(|error| internal_error(format!("validate current reply message: {error}")))?;
    if current.is_none() {
        return Err(forbidden(
            "current reply message is not bound to this human turn",
        ));
    }
    for source in &snapshot.sources {
        let authoritative = human_source(
            &tx,
            claims.project_id,
            conversation_id,
            user_id,
            source.message_id,
        )
        .await?;
        if source.text != authoritative.text
            && !(snapshot.truncated && authoritative.text.starts_with(&source.text))
        {
            return Err(conflict("a reply source changed after routing"));
        }
    }
    let context = RequestContext {
        user_id: Some(user_id),
        is_service_role: false,
        scoped_claims: None,
    };
    let lock_key = format!("worker-input-reply:{}", snapshot.current_message_id);
    tx.query_one(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&lock_key],
    )
    .await
    .map_err(|error| internal_error(format!("lock reply source: {error}")))?;
    body.answers
        .sort_by(|a, b| (a.request_id, &a.question_id).cmp(&(b.request_id, &b.question_id)));
    let mut decision =
        serde_json::to_value(&body).map_err(|error| bad_request(error.to_string()))?;
    decision
        .as_object_mut()
        .expect("reply object")
        .remove("runtimeId");
    // Replays remain subject to the human's current access and ownership, even
    // after a valid answer already resumed the worker on a different runtime.
    for request in &snapshot.requests {
        if let Some(row) = tx
            .query_opt(
                "select * from agent_user_input_requests where id=$1",
                &[&request.request_id],
            )
            .await
            .map_err(|error| internal_error(format!("authorize reply replay: {error}")))?
        {
            authorize_human(&tx, &context, &row, true).await?;
        } else {
            return Err(conflict("a worker question was removed"));
        }
    }
    if let Some(prior) = tx.query_opt(
        "select payload #> '{metadata,workerInputReplyReceipt}' as receipt from agent_jobs where project_id=$1 and conversation_id=$2 and payload #>> '{metadata,workerInputReplyReceipt,currentMessageId}'=$3 limit 1",
        &[&claims.project_id,&conversation_id,&snapshot.current_message_id.to_string()],
    ).await.map_err(|error| internal_error(format!("load reply replay receipt: {error}")))? {
        let receipt = prior.get::<_, PgJson<Value>>("receipt").0;
        if receipt.get("decision") != Some(&decision) { return Err(conflict("this human message already has a different routing decision")); }
        return Ok(Json(json!({"ok":true,"disposition":body.disposition,"requestIds":receipt["requestIds"]})));
    }
    let target_ids: Vec<Uuid> = if body.disposition == "clarify" {
        snapshot
            .requests
            .iter()
            .map(|request| request.request_id)
            .filter(|id| {
                snapshot
                    .sources
                    .iter()
                    .all(|source| source.message_id == snapshot.current_message_id)
                    || snapshot.clarification_request_ids.contains(id)
            })
            .collect()
    } else {
        grouped.keys().copied().collect()
    };
    if target_ids.is_empty() {
        return Err(conflict(
            "the earlier clarification no longer has a pending recipient",
        ));
    }
    // Group-before-job locking agrees with Stop and continuation dispatch.
    let groups = tx.query("select distinct group_id from agent_user_input_requests where id=any($1) order by group_id", &[&target_ids]).await
        .map_err(|error| internal_error(format!("load reply groups: {error}")))?;
    for group in groups {
        crate::multi_agent_plan::lock_plan_group_checkpoint(
            &tx,
            &group.get::<_, Uuid>("group_id").to_string(),
        )
        .await?;
    }
    let locked = tx.query_opt(
        "select payload from agent_jobs where id=$1 and project_id=$2 and status='leased' and leased_by_runtime_id=$3 and lease_expires_at>now() for update",
        &[&job_id,&claims.project_id,&body.runtime_id],
    ).await.map_err(|error| internal_error(format!("lock routing job: {error}")))?
        .ok_or_else(|| conflict("reply routing job stopped while resolving its questions"))?;
    if locked
        .get::<_, PgJson<Value>>("payload")
        .0
        .pointer("/metadata/workerInputRouting")
        != Some(&issued)
    {
        return Err(conflict(
            "controller question context changed while routing",
        ));
    }
    let rows = tx.query(
        "select q.*,j.status as source_status,j.lease_attempts,j.leased_by_runtime_id,j.lease_expires_at
         from agent_user_input_requests q join agent_jobs j on j.id=q.job_id where q.id=any($1) order by q.id for update of j,q",
        &[&target_ids],
    ).await.map_err(|error| internal_error(format!("lock reply recipients: {error}")))?;
    if rows.len() != target_ids.len() {
        return Err(conflict("a pending question is no longer available"));
    }
    for row in &rows {
        if row.get::<_, Uuid>("project_id") != claims.project_id
            || row.get::<_, Uuid>("conversation_id") != conversation_id
        {
            return Err(forbidden("worker answer recipient belongs to another chat"));
        }
        authorize_human(&tx, &context, row, true).await?;
        let id: Uuid = row.get("id");
        let pending = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == id)
            .ok_or_else(|| forbidden("recipient not issued to this job"))?;
        let questions = row.get::<_, PgJson<Value>>("questions").0;
        if questions != json!(pending.questions) || row.get::<_, String>("status") != "pending" {
            return Err(conflict(
                "a worker question changed or was already answered",
            ));
        }
        let status: String = row.get("source_status");
        let active = row.get::<_, i32>("lease_attempt") == row.get::<_, i32>("lease_attempts")
            && (status == "completed"
                || (status == "leased"
                    && row.get::<_, Option<Uuid>>("runtime_id")
                        == row.get::<_, Option<Uuid>>("leased_by_runtime_id")
                    && row
                        .get::<_, Option<chrono::DateTime<chrono::Utc>>>("lease_expires_at")
                        .is_some_and(|expiry| expiry > chrono::Utc::now())));
        if !active
            || crate::multi_agent_plan::plan_group_was_stopped(
                &tx,
                claims.project_id,
                conversation_id,
                &row.get::<_, Uuid>("group_id").to_string(),
            )
            .await?
        {
            return Err(conflict("a worker question is no longer active"));
        }
    }
    // Validate the complete batch before any answer changes. Its source message
    // already exists in the chat, so natural replies never duplicate it.
    for (request_id, answers) in &grouped {
        tx.execute(
            "update agent_user_input_requests set status='answered',answers=$2,answered_by=$3,answer_message_id=$4,answered_at=now(),updated_at=now() where id=$1 and status='pending'",
            &[request_id,&PgJson(json!(answers)),&user_id,&snapshot.current_message_id],
        ).await.map_err(|error| internal_error(format!("apply natural worker reply: {error}")))?;
    }
    let receipt = json!({"currentMessageId":snapshot.current_message_id,"requestedUserId":user_id,"decision":decision,"sources":snapshot.sources,"requestIds":target_ids});
    tx.execute("update agent_jobs set payload=jsonb_set(payload,'{metadata,workerInputReplyReceipt}',$2,true),updated_at=now() where id=$1", &[&job_id,&PgJson(receipt)]).await
        .map_err(|error| internal_error(format!("persist reply routing receipt: {error}")))?;
    tx.commit()
        .await
        .map_err(|error| internal_error(format!("commit natural worker reply: {error}")))?;
    drop(connection);
    for request_id in grouped.keys() {
        publish_request_run_event(&state, *request_id).await;
        // A durable answer remains successful if immediate scheduling fails;
        // the existing bounded recovery sweep retries continuation admission.
        if let Err((status, Json(error))) =
            crate::multi_agent_plan::user_input::resume_answered_request(&state, *request_id).await
        {
            tracing::warn!(%request_id,%status,error=%error.message,"natural reply saved; continuation deferred to recovery");
        }
    }
    Ok(Json(
        json!({"ok":true,"disposition":body.disposition,"requestIds":target_ids}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpts_are_exact_and_batches_require_complete_distinct_question_sets() {
        let source = Uuid::new_v4();
        let request = Uuid::new_v4();
        let questions = vec![
            Question {
                id: "tone".into(),
                header: "Tone".into(),
                question: "Which tone?".into(),
                options: None,
                is_other: false,
                is_secret: false,
            },
            Question {
                id: "length".into(),
                header: "Length".into(),
                question: "How long?".into(),
                options: None,
                is_other: false,
                is_secret: false,
            },
        ];
        let snapshot = Snapshot {
            current_message_id: source,
            requests: vec![Pending {
                request_id: request,
                message_id: None,
                agent_handle: "writer".into(),
                task_label: None,
                questions,
            }],
            sources: vec![Source {
                message_id: source,
                text: "Playful and short".into(),
            }],
            truncated: false,
            remaining_request: None,
            clarification_request_ids: Vec::new(),
        };
        let mut reply = ReplyRequest {
            runtime_id: Uuid::new_v4(),
            disposition: "answer".into(),
            answers: vec![AnswerExcerpt {
                request_id: request,
                question_id: "tone".into(),
                source_message_id: source,
                value: "Playful".into(),
            }],
            clarification: None,
            remaining_request: None,
        };
        assert!(validate_reply(&snapshot, &reply).is_err());
        reply.answers.push(AnswerExcerpt {
            request_id: request,
            question_id: "length".into(),
            source_message_id: source,
            value: "short".into(),
        });
        assert_eq!(
            validate_reply(&snapshot, &reply).unwrap()[&request]["tone"],
            vec!["Playful"]
        );
        reply.answers[0].value = "Cheerful".into();
        assert!(validate_reply(&snapshot, &reply).is_err());
        reply.answers[0].value = "Playful".into();
        reply.answers[0].source_message_id = Uuid::new_v4();
        assert!(validate_reply(&snapshot, &reply).is_err());
        reply.answers[0].source_message_id = source;
        reply.answers.push(reply.answers[0].clone());
        assert!(validate_reply(&snapshot, &reply).is_err());
        reply.answers.pop();
        let mut truncated = snapshot.clone();
        truncated.truncated = true;
        assert!(validate_reply(&truncated, &reply).is_err());
        reply.disposition = "clarify".into();
        reply.clarification = Some("Which task?".into());
        assert!(validate_reply(&snapshot, &reply).is_err());
        reply.answers.clear();
        assert!(validate_reply(&snapshot, &reply).unwrap().is_empty());
    }

    #[test]
    fn public_metadata_cannot_hide_routing_authority_in_nested_arrays() {
        let mut value = json!({"workerInputRouting":{},"details":[{"nested":{"workerInputReplyReceipt":{},"keep":true}}]});
        strip_claims(&mut value);
        assert_eq!(value, json!({"details":[{"nested":{"keep":true}}]}));
    }
}
