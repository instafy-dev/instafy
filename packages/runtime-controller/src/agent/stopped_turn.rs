//! The one end report of a turn the person stopped.
//!
//! A Stop cancels the job here at once (`conversation_stop`), and its runtime
//! learns of it at the job's next heartbeat or refused report. A step the
//! model sent before then has run, and the job's save at its end keeps what it
//! changed. The runtime sends no completion for a cancelled job, so it sends
//! this report instead (`POST /agent/stopped`): the step that names what the
//! turn changed, as its runtime streams a finished step, and the turn's
//! `apply/files` artifact, as a finished turn's reply carries it.
//!
//! It is taken only from the runtime that held the job, with an agent token of
//! that runtime's current launch, for a job cancelled in the last
//! [`REPORT_WINDOW_SECONDS`], and only once. It records and reopens nothing
//! else: the job and its run stay cancelled, no queued send is drained, and no
//! credit moves. The turn's charge stays as the Stop left it (its reserve, see
//! `project_work_cancellation`): the report carries changes, not usage.
//!
//! The step lands in the turn's thread, so its line reads "Stopped · …, edited
//! a file" and Details lists the edit, and the files under it, with Review
//! changes and Undo. Unlike a running turn's progress, it stays in the
//! conversation history that later turns read: it is what the stopped turn
//! left, which a turn that goes on, or undoes it, needs to know.

use super::*;

/// How long after its Stop a cancelled job's report is taken: its runtime
/// learns of the Stop within a second or two, shuts the turn down and saves
/// its folder (`rolling_saves`), well within this.
const REPORT_WINDOW_SECONDS: f64 = 120.0;

/// The most files one report lists, as the runtime bounds a payload's lists.
const MAX_REPORTED_FILES: usize = 80;

/// The longest path a reported file may have.
const MAX_REPORTED_PATH_CHARS: usize = 1_024;

/// The step's id in its turn's thread.
const STOPPED_TURN_STEP_ITEM_ID: &str = "stopped-turn-files";

#[derive(Debug, Deserialize)]
pub(crate) struct AgentStoppedPayload {
    #[serde(rename = "job_id")]
    job_id: String,
    content: String,
    #[serde(rename = "message_type", alias = "messageType")]
    message_type: String,
    metadata: Option<JsonValue>,
    artifacts: JsonValue,
}

#[derive(Debug, Serialize)]
pub(crate) struct AgentStoppedResponseBody {
    ok: bool,
}

/// The report's `apply/files` artifact, checked: one artifact, listing at
/// least one and at most [`MAX_REPORTED_FILES`] workspace-relative paths.
fn checked_files_artifact(
    artifacts: &JsonValue,
) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let Some([artifact]) = artifacts.as_array().map(Vec::as_slice) else {
        return Err(bad_request(
            "a stopped turn's report carries one apply/files artifact",
        ));
    };
    if artifact.get("kind").and_then(JsonValue::as_str) != Some("apply/files") {
        return Err(bad_request(
            "a stopped turn's report carries one apply/files artifact",
        ));
    }
    let files = artifact
        .get("files")
        .and_then(JsonValue::as_array)
        .filter(|files| !files.is_empty() && files.len() <= MAX_REPORTED_FILES)
        .ok_or_else(|| bad_request("a stopped turn's report lists 1 to 80 files"))?;
    for file in files {
        let relative = |key: &str| {
            file.get(key)
                .and_then(JsonValue::as_str)
                .is_some_and(|path| {
                    !path.trim().is_empty()
                        && path.chars().count() <= MAX_REPORTED_PATH_CHARS
                        && !path.starts_with('/')
                        && !path.contains('\\')
                        && !path.split('/').any(|segment| segment == "..")
                })
        };
        if !relative("path") || (file.get("workspacePath").is_some() && !relative("workspacePath"))
        {
            return Err(bad_request(
                "a stopped turn's files are paths inside its workspace",
            ));
        }
    }
    Ok(artifact.clone())
}

pub(crate) async fn agent_stopped(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<AgentStoppedPayload>,
) -> Result<Json<AgentStoppedResponseBody>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.complete"])?;
    let runtime_id = claims.runtime_id.ok_or_else(|| {
        unauthorized("a stopped turn's report comes from the runtime that ran it")
    })?;
    let job_id =
        Uuid::from_str(&payload.job_id).map_err(|_| bad_request("job_id must be a valid UUID"))?;
    if payload.message_type.trim() != "file_change" {
        return Err(bad_request(
            "a stopped turn's report is its file_change step",
        ));
    }
    let content = sanitize_postgres_text(payload.content.trim());
    if content.is_empty() {
        return Err(bad_request("content must not be empty"));
    }
    let files_artifact = sanitize_json_for_postgres(checked_files_artifact(&payload.artifacts)?);
    let artifacts = JsonValue::Array(vec![files_artifact]);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    // The runtime's current launch: a deleted space's runtime is refused.
    ensure_agent_token_matches_runtime_lease_for_job(&state, &transaction, &claims, &runtime_id)
        .await?;
    // Only the runtime that held the job, for a job cancelled moments ago,
    // and only once: the job's artifacts are its record of the report. The
    // job stays cancelled.
    let row = transaction
        .query_opt(
            "update agent_jobs
             set artifacts = $4::jsonb
             where id = $1
               and project_id = $2
               and status = 'canceled'
               and leased_by_runtime_id = $3
               and artifacts = '[]'::jsonb
               and completed_at > now() - $5 * interval '1 second'
             returning run_id, prompt_id, session_id, conversation_id, payload,
                       created_at, leased_at, completed_at, lease_attempts,
                       leased_by_runtime_id",
            &[
                &job_id,
                &claims.project_id,
                &runtime_id,
                &PgJson(&artifacts),
                &REPORT_WINDOW_SECONDS,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record a stopped turn: {error}")))?
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "the job is not a turn this runtime ran and that was just stopped",
                )),
            )
        })?;
    let job_payload: JsonValue = row.get::<_, PgJson<JsonValue>>("payload").0;
    let conversation_id = row.get::<_, Option<Uuid>>("conversation_id").or_else(|| {
        job_payload
            .get("conversation_id")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::from_str(value).ok())
    });
    let Some(conversation_id) = conversation_id else {
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to commit a stopped turn's report: {error}"))
        })?;
        return Ok(Json(AgentStoppedResponseBody { ok: true }));
    };
    let lease_metrics = build_agent_lease_metrics(
        &job_payload,
        row.get("created_at"),
        row.get("leased_at"),
        row.get("completed_at"),
        row.get("lease_attempts"),
        row.get("leased_by_runtime_id"),
        None,
    );
    let mut details = match payload.metadata {
        Some(JsonValue::Object(details)) => details,
        _ => JsonMap::new(),
    };
    details.insert("itemId".to_string(), json!(STOPPED_TURN_STEP_ITEM_ID));
    let mut metadata = attach_lease_metrics_to_metadata(
        merge_runtime_preference_from_job_payload(
            build_agent_update_metadata(
                &job_id,
                Some("file_change"),
                Some(JsonValue::Object(details)),
            ),
            &job_payload,
        ),
        Some(&lease_metrics),
    );
    if let Some(map) = metadata.as_object_mut() {
        // The step of a turn that has ended, not progress: later turns read it.
        map.insert("outcome".to_string(), json!("canceled"));
        map.insert("artifacts".to_string(), artifacts);
    }
    let metadata = sanitize_json_for_postgres(metadata);
    let internal_conversation =
        crate::conversations::is_internal_conversation(&transaction, &conversation_id).await?;
    // Neither a reply nor the conversation's newest news: it bumps nothing.
    let message = insert_agent_conversation_message(
        &transaction,
        &claims.project_id,
        &conversation_id,
        row.get::<_, Option<Uuid>>("session_id").or_else(|| {
            job_payload
                .get("session_id")
                .and_then(JsonValue::as_str)
                .and_then(|value| Uuid::from_str(value).ok())
        }),
        row.get("prompt_id"),
        row.get("run_id"),
        content,
        metadata,
        internal_conversation,
        false,
    )
    .await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit a stopped turn's report: {error}"))
    })?;
    publish_conversation_message_event(&state.events, &message);
    Ok(Json(AgentStoppedResponseBody { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(paths: &[&str]) -> JsonValue {
        json!([{
            "kind": "apply/files",
            "files": paths.iter().map(|path| json!({
                "path": path, "workspacePath": path, "changeType": "changed",
            })).collect::<Vec<_>>(),
        }])
    }

    #[test]
    fn a_report_lists_workspace_files_in_one_apply_files_artifact() {
        assert!(checked_files_artifact(&files(&["sites/porto/app.js"])).is_ok());
        for refused in [
            json!([]),
            files(&[]),
            files(&["/etc/passwd"]),
            files(&["sites/../../secrets"]),
            files(&["sites\\porto\\app.js"]),
            files(&[" "]),
            json!([{ "kind": "origin/apply", "files": [{ "path": "a" }] }]),
            json!([files(&["a"])[0].clone(), files(&["b"])[0].clone()]),
        ] {
            assert!(checked_files_artifact(&refused).is_err(), "{refused}");
        }
        let many: Vec<String> = (0..=MAX_REPORTED_FILES).map(|n| format!("f{n}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(checked_files_artifact(&files(&many)).is_err());
    }
}
