//! The one end report of a turn the person stopped.
//!
//! A Stop cancels the job here at once (`conversation_stop`), and its runtime
//! learns of it at the job's next heartbeat or refused report. A step the
//! model sent before then has run, and the job's save at its end keeps what it
//! changed. The runtime sends no completion for a cancelled job, and a Stop
//! that came after the model was done (while the turn saved) has its
//! completion refused, so it sends this report instead (`POST /agent/stopped`):
//! the step that names what the turn changed, as its runtime streams a
//! finished step, and the turn's `apply/files` artifact, as a finished turn's
//! reply carries it, with the turn's `origin/apply` save when it ran one.
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
//! changes and Undo. An edit whose own step the chat already shows is not
//! named again: the step names only the files no recorded step of the turn
//! named, and when every file was named, it restates the turn's newest edit
//! step (its own item, so Details keeps one row for it) with the files
//! attached. Unlike a running turn's progress, it stays in the conversation
//! history that later turns read: it is what the stopped turn left, which a
//! turn that goes on, or undoes it, needs to know.

use super::*;

/// How long after its Stop a cancelled job's report is taken: its runtime
/// learns of the Stop within a second or two, shuts the turn down and saves
/// its folder (`rolling_saves`), well within this.
const REPORT_WINDOW_SECONDS: f64 = 120.0;

/// The most files one report lists, as the runtime bounds a payload's lists.
const MAX_REPORTED_FILES: usize = 80;

/// The longest path a reported file may have.
const MAX_REPORTED_PATH_CHARS: usize = 1_024;

/// The step's id in its turn's thread, when it names files no step of the
/// turn named.
const STOPPED_TURN_STEP_ITEM_ID: &str = "stopped-turn-files";

/// The job artifact that says its stopped turn was reported: the report is
/// taken once, whatever an earlier attempt of the job (one a short rate limit
/// put back in the queue) left in its artifacts.
const REPORTED_MARKER_KIND: &str = "stopped-turn/reported";

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

/// A path the report names: not empty, and not too long.
fn reported_path(path: &JsonValue) -> Option<&str> {
    path.as_str()
        .filter(|path| !path.trim().is_empty() && path.chars().count() <= MAX_REPORTED_PATH_CHARS)
}

/// The report's artifacts, checked: one `apply/files` artifact listing at
/// least one and at most [`MAX_REPORTED_FILES`] workspace-relative paths,
/// and at most one `origin/apply` artifact, the turn's own save.
fn checked_artifacts(
    artifacts: &JsonValue,
) -> Result<Vec<JsonValue>, (StatusCode, Json<ApiError>)> {
    let refused =
        || bad_request("a stopped turn's report carries one apply/files artifact, and its save");
    let artifacts = artifacts.as_array().ok_or_else(refused)?;
    let of_kind = |kind: &str| {
        artifacts
            .iter()
            .filter(|artifact| artifact.get("kind").and_then(JsonValue::as_str) == Some(kind))
            .collect::<Vec<_>>()
    };
    let (files_artifacts, saves) = (of_kind("apply/files"), of_kind("origin/apply"));
    let ([files_artifact], [] | [_]) = (files_artifacts.as_slice(), saves.as_slice()) else {
        return Err(refused());
    };
    if files_artifacts.len() + saves.len() != artifacts.len()
        || saves
            .iter()
            .any(|save| !save.get("metadata").is_some_and(JsonValue::is_object))
    {
        return Err(refused());
    }
    let files = files_artifact
        .get("files")
        .and_then(JsonValue::as_array)
        .filter(|files| !files.is_empty() && files.len() <= MAX_REPORTED_FILES)
        .ok_or_else(|| bad_request("a stopped turn's report lists 1 to 80 files"))?;
    for file in files {
        let relative = |key: &str| {
            file.get(key).and_then(reported_path).is_some_and(|path| {
                !path.starts_with('/')
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
    Ok(std::iter::once((*files_artifact).clone())
        .chain(saves.into_iter().cloned())
        .collect())
}

/// A step's path as a key: the same file however its segments were joined.
fn path_key(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// The turn's file-change steps its chat already shows: the paths they named,
/// and the newest of them (its words and details, its label among them).
#[derive(Default)]
struct ShownEdits {
    paths: HashSet<String>,
    newest: Option<(String, JsonMap<String, JsonValue>)>,
}

async fn shown_edits(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    job_id: &Uuid,
) -> Result<ShownEdits, (StatusCode, Json<ApiError>)> {
    let rows = transaction
        .query(
            "select content, metadata
               from conversation_messages
              where project_id = $1
                and conversation_id = $2
                and coalesce(metadata ->> 'jobId', metadata ->> 'job_id') = $3
                and lower(coalesce(metadata ->> 'messageType', metadata ->> 'message_type', ''))
                    = 'file_change'
                and lower(coalesce(metadata #>> '{details,status}', '')) = 'completed'
              order by created_at, id",
            &[project_id, conversation_id, &job_id.to_string()],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to read a stopped turn's steps: {error}"))
        })?;
    let mut shown = ShownEdits::default();
    for row in rows {
        let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
        let Some(mut details) = metadata
            .get("details")
            .and_then(JsonValue::as_object)
            .cloned()
        else {
            continue;
        };
        for path in details
            .get("paths")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter_map(JsonValue::as_str)
        {
            shown.paths.insert(path_key(path));
        }
        // The label the controller lifted out of the step's details goes back
        // in, so the restated step is labelled as the step was.
        if let Some(activity) = metadata.get("activity") {
            details.insert("activity".to_string(), activity.clone());
        }
        shown.newest = Some((row.get("content"), details));
    }
    Ok(shown)
}

/// The step the report records: the edit of the files no recorded step of
/// the turn named, or, when the chat already shows every one, the turn's
/// newest edit step again (its own item, so Studio keeps one row for it),
/// which the report's files are attached to.
fn step_to_record(
    mut details: JsonMap<String, JsonValue>,
    shown: ShownEdits,
) -> Result<(String, JsonMap<String, JsonValue>), (StatusCode, Json<ApiError>)> {
    let reported = details
        .get("paths")
        .and_then(JsonValue::as_array)
        .filter(|paths| !paths.is_empty() && paths.len() <= MAX_REPORTED_FILES)
        .and_then(|paths| paths.iter().map(reported_path).collect::<Option<Vec<_>>>())
        .ok_or_else(|| bad_request("a stopped turn's step names 1 to 80 files"))?;
    let mut seen = HashSet::new();
    let unshown: Vec<String> = reported
        .into_iter()
        .filter(|path| {
            let key = path_key(path);
            !shown.paths.contains(&key) && seen.insert(key)
        })
        .map(str::to_string)
        .collect();
    if unshown.is_empty() {
        if let Some(newest) = shown.newest {
            return Ok(newest);
        }
    }
    let paths = if unshown.is_empty() {
        // Not reached: a path no recorded step named is never shown.
        details.get("paths").cloned().unwrap_or_default()
    } else {
        json!(unshown)
    };
    let count = paths.as_array().map_or(0, Vec::len);
    if let Some(activity) = details
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
    {
        activity.insert("count".to_string(), json!(count));
    }
    let content = format!(
        "Applied file changes: {}",
        paths
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(JsonValue::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    );
    details.insert("paths".to_string(), paths);
    details.insert("itemId".to_string(), json!(STOPPED_TURN_STEP_ITEM_ID));
    Ok((content, details))
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
    if payload.content.trim().is_empty() {
        return Err(bad_request("content must not be empty"));
    }
    let details = match payload.metadata {
        Some(JsonValue::Object(details)) => details,
        _ => JsonMap::new(),
    };
    let artifacts =
        sanitize_json_for_postgres(JsonValue::Array(checked_artifacts(&payload.artifacts)?));
    let mut recorded = artifacts.as_array().cloned().unwrap_or_default();
    recorded.push(json!({ "kind": REPORTED_MARKER_KIND }));
    let recorded = JsonValue::Array(recorded);
    let marker = json!([{ "kind": REPORTED_MARKER_KIND }]);

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
    // and only once: the marker among the job's artifacts says it was
    // reported. The job stays cancelled.
    let row = transaction
        .query_opt(
            "update agent_jobs
             set artifacts = coalesce(artifacts, '[]'::jsonb) || $4::jsonb
             where id = $1
               and project_id = $2
               and status = 'canceled'
               and leased_by_runtime_id = $3
               and not coalesce(artifacts, '[]'::jsonb) @> $6::jsonb
               and completed_at > now() - $5 * interval '1 second'
             returning run_id, prompt_id, session_id, conversation_id, payload,
                       created_at, leased_at, completed_at, lease_attempts,
                       leased_by_runtime_id",
            &[
                &job_id,
                &claims.project_id,
                &runtime_id,
                &PgJson(&recorded),
                &REPORT_WINDOW_SECONDS,
                &PgJson(&marker),
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
    let shown = shown_edits(&transaction, &claims.project_id, &conversation_id, &job_id).await?;
    let (content, details) = step_to_record(details, shown)?;
    let content = sanitize_postgres_text(content.trim());
    let lease_metrics = build_agent_lease_metrics(
        &job_payload,
        row.get("created_at"),
        row.get("leased_at"),
        row.get("completed_at"),
        row.get("lease_attempts"),
        row.get("leased_by_runtime_id"),
        None,
    );
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

    fn save() -> JsonValue {
        json!({ "kind": "origin/apply", "metadata": { "gitSyncStatus": "synced" } })
    }

    #[test]
    fn a_report_lists_workspace_files_in_one_apply_files_artifact_and_its_save() {
        assert!(checked_artifacts(&files(&["sites/porto/app.js"])).is_ok());
        let with_save = json!([files(&["sites/porto/app.js"])[0].clone(), save()]);
        assert_eq!(checked_artifacts(&with_save).unwrap().len(), 2);
        for refused in [
            json!([]),
            files(&[]),
            files(&["/etc/passwd"]),
            files(&["sites/../../secrets"]),
            files(&["sites\\porto\\app.js"]),
            files(&[" "]),
            json!([{ "kind": "origin/apply", "files": [{ "path": "a" }] }]),
            json!([files(&["a"])[0].clone(), files(&["b"])[0].clone()]),
            json!([files(&["a"])[0].clone(), save(), save()]),
            json!([files(&["a"])[0].clone(), { "kind": "origin/apply" }]),
            json!([files(&["a"])[0].clone(), { "kind": "ai/task-usage", "usage": {} }]),
        ] {
            assert!(checked_artifacts(&refused).is_err(), "{refused}");
        }
        let many: Vec<String> = (0..=MAX_REPORTED_FILES).map(|n| format!("f{n}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(checked_artifacts(&files(&many)).is_err());
    }

    fn step(paths: &[&str]) -> JsonMap<String, JsonValue> {
        json!({
            "kind": "codex_file_change",
            "itemId": "stopped-turn-files",
            "status": "completed",
            "paths": paths,
            "activity": { "v": 1, "key": "builtin/edit", "count": paths.len() },
        })
        .as_object()
        .cloned()
        .unwrap()
    }

    fn shown(steps: &[(&str, &[&str])]) -> ShownEdits {
        let mut shown = ShownEdits::default();
        for (item, paths) in steps {
            shown.paths.extend(paths.iter().map(|path| path_key(path)));
            let mut details = step(paths);
            details.insert("itemId".to_string(), json!(item));
            shown.newest = Some((
                format!("Applied file changes: {}", paths.join(", ")),
                details,
            ));
        }
        shown
    }

    /// An edit the chat already shows is not named again: the step names only
    /// what no step of the turn named, or restates the turn's newest edit.
    #[test]
    fn the_step_names_only_what_the_chat_does_not_show_yet() {
        let page = "/workspace/p/sites/porto/app.js";
        let route = "/workspace/p/sites/porto/route.html";

        // Nothing shown (the edit's own step was refused after the Stop).
        let (content, details) = step_to_record(step(&[page]), ShownEdits::default()).unwrap();
        assert_eq!(content, format!("Applied file changes: {page}"));
        assert_eq!(details["paths"], json!([page]));
        assert_eq!(details["itemId"], "stopped-turn-files");

        // The edit's step was shown: the turn's newest edit, restated.
        let (content, details) =
            step_to_record(step(&[page]), shown(&[("call_edit", &[page])])).unwrap();
        assert_eq!(content, format!("Applied file changes: {page}"));
        assert_eq!(details["itemId"], "call_edit");
        assert_eq!(details["paths"], json!([page]));

        // One shown, one not (a command wrote it): only that one, counted once.
        let (content, details) = step_to_record(
            step(&[page, route]),
            shown(&[("call_edit", &["/workspace/p/./sites/porto/app.js"])]),
        )
        .unwrap();
        assert_eq!(content, format!("Applied file changes: {route}"));
        assert_eq!(details["paths"], json!([route]));
        assert_eq!(details["activity"]["count"], 1);
        assert_eq!(details["itemId"], "stopped-turn-files");

        // A step that names no file is no report.
        assert!(step_to_record(step(&[]), ShownEdits::default()).is_err());
    }
}
