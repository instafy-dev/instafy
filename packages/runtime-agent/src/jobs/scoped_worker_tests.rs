use super::tests::{test_job_processor, test_lease_job};
use super::*;

fn read_only_worker(paths: &[&str]) -> LeaseJob {
    test_lease_job(
        Some("feature"),
        json!({
            "metadata": {
                "multiAgentPlan": { "role": "worker", "groupId": "coverage-test" },
                "writeScope": { "mode": "read_only", "readOnlyPaths": paths },
            }
        }),
    )
}

#[test]
fn scoped_worker_incomplete_previews_retain_tools_and_scope() {
    let temp = tempfile::tempdir().unwrap();
    let text = format!(
        "{}\nimportant source tail",
        "x".repeat(SCOPED_WORKER_FILE_SNIPPET_CHARS)
    );
    fs::write(temp.path().join("source.txt"), text).unwrap();
    let processor = test_job_processor(temp.path());
    let mut job = read_only_worker(&["source.txt"]);
    let project_id = Uuid::new_v4();
    job.project_id = Some(project_id);
    let observation = build_scoped_worker_path_observation(temp.path(), &job).unwrap();
    assert!(!observation.complete);
    assert_eq!(observation.artifact["paths"][0]["truncated"], true);
    assert!(!observation.section.contains("important source tail"));
    let (prompt, _, metrics) = processor
        .build_prompt_with_text(
            &project_id,
            &job,
            temp.path(),
            "Review the scoped source.",
            true,
            None,
            &[],
            Some(&observation),
            None,
        )
        .unwrap();
    assert_ne!(metrics["promptMode"], "scoped_worker_preobserved");
    assert!(prompt.contains("Use available read-only tools"));
    assert!(!prompt.contains("produce the lane report from the evidence below"));
    assert!(metadata_requests_read_only_workspace(
        job.payload.get("metadata")
    ));
    assert!(!metadata_requests_write_scoped_workspace(
        job.payload.get("metadata")
    ));
    assert_eq!(
        fs::read_to_string(temp.path().join("source.txt"))
            .unwrap()
            .len(),
        SCOPED_WORKER_FILE_SNIPPET_CHARS + 22
    );
}

#[test]
fn scoped_worker_complete_files_keep_compact_lane_but_samples_and_missing_paths_do_not() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("source.txt"), "complete file").unwrap();
    let complete =
        build_scoped_worker_path_observation(temp.path(), &read_only_worker(&["source.txt"]))
            .unwrap();
    assert!(complete.complete);
    assert_eq!(complete.artifact["coverage"]["complete"], true);
    for path in [
        "missing.txt",
        "../outside.txt",
        "*.txt",
        "source.txt?",
        "source.txt/**",
    ] {
        let observation =
            build_scoped_worker_path_observation(temp.path(), &read_only_worker(&[path])).unwrap();
        assert!(!observation.complete, "{path} must not claim full coverage");
    }
    fs::create_dir(temp.path().join("src")).unwrap();
    fs::write(temp.path().join("src/code.rs"), "fn code() {}").unwrap();
    let sampled =
        build_scoped_worker_path_observation(temp.path(), &read_only_worker(&["src/**"])).unwrap();
    assert!(
        !sampled.complete,
        "directory sampling is not exhaustive inspection"
    );
    assert_eq!(sampled.artifact["paths"][0]["status"], "listed");
}

#[test]
fn scoped_worker_budgets_remain_bounded_and_omissions_are_visible() {
    let temp = tempfile::tempdir().unwrap();
    let names = (0..7).map(|i| format!("source{i}.txt")).collect::<Vec<_>>();
    for name in &names {
        fs::write(
            temp.path().join(name),
            "x".repeat(SCOPED_WORKER_FILE_SNIPPET_CHARS),
        )
        .unwrap();
    }
    let paths = names.iter().map(String::as_str).collect::<Vec<_>>();
    let observation =
        build_scoped_worker_path_observation(temp.path(), &read_only_worker(&paths)).unwrap();
    assert!(!observation.complete);
    assert_eq!(observation.artifact["coverage"]["omittedPathCount"], 1);
    let entries = observation.artifact["paths"].as_array().unwrap();
    assert_eq!(entries.len(), SCOPED_WORKER_MAX_OBSERVATION_PATHS);
    let total: usize = entries
        .iter()
        .map(|entry| entry["snippet"].as_str().unwrap().chars().count())
        .sum();
    assert_eq!(total, SCOPED_WORKER_TOTAL_SNIPPET_CHARS);
    assert_eq!(entries.last().unwrap()["truncated"], true);
}

#[tokio::test]
async fn scoped_worker_compact_request_transmits_selected_effort_and_records_it() {
    use axum::{extract::State, routing::post};
    type Captured = Arc<Mutex<Option<JsonValue>>>;
    async fn completion(
        State(captured): State<Captured>,
        axum::Json(body): axum::Json<JsonValue>,
    ) -> axum::Json<JsonValue> {
        *captured.lock() = Some(body);
        axum::Json(
            json!({"choices":[{"message":{"content":"Inspected the complete supplied file."}}]}),
        )
    }
    let captured: Captured = Arc::new(Mutex::new(None));
    let router = axum::Router::new()
        .route("/v1/chat/completions", post(completion))
        .with_state(captured.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("source.txt"), "complete file").unwrap();
    let observation =
        build_scoped_worker_path_observation(temp.path(), &read_only_worker(&["source.txt"]))
            .unwrap();
    let config = DirectWorkerProxyConfig {
        chat_completions_endpoint: format!("http://{address}/v1/chat/completions"),
        api_key: "inert-scoped-test-token".into(),
        model: "saved-worker-model".into(),
        reasoning_effort: ReasoningEffort::High,
    };
    let result = execute_preobserved_scoped_worker_direct(
        "Review the supplied file.",
        &JsonValue::Null,
        &observation,
        Uuid::new_v4(),
        &config,
    )
    .await
    .unwrap();
    server.abort();
    let request = captured.lock().clone().unwrap();
    assert_eq!(request["model"], "saved-worker-model");
    assert_eq!(request["reasoning_effort"], "high");
    assert!(request.get("reasoning").is_none());
    assert_eq!(request["tool_choice"], "none");
    assert_eq!(result.artifacts[0]["metadata"]["reasoningEffort"], "high");
}

#[tokio::test]
async fn direct_workers_defer_questions_without_forcing_files_or_tool_calls() {
    use axum::{extract::State, routing::post};
    async fn completion(State(output): State<Arc<Mutex<JsonValue>>>) -> axum::Json<JsonValue> {
        axum::Json(json!({"choices":[{"message":{"content":output.lock().to_string()}}]}))
    }
    let question = json!({"summary":"Which tone should I use?", "files":[], "actions":[{
        "type":"request_user_input", "questions":[{"id":"tone", "header":"Tone", "question":"Which tone?"}],
        "continuationNote":"No files changed. Write poem.txt after the tone choice."}]});
    let output = Arc::new(Mutex::new(question));
    let router = axum::Router::new()
        .route("/v1/chat/completions", post(completion))
        .with_state(output.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let config = DirectWorkerProxyConfig {
        chat_completions_endpoint: format!("http://{address}/v1/chat/completions"),
        api_key: "inert-scoped-test-token".into(),
        model: "test-model".into(),
        reasoning_effort: ReasoningEffort::Low,
    };
    let temp = tempfile::tempdir().unwrap();
    let job = test_lease_job(
        Some("feature"),
        json!({"metadata":{
        "multiAgentPlan":{"role":"worker", "groupId":"test"},
        "writeScope":{"mode":"owned", "ownedPaths":["poem.txt"]}}}),
    );
    let scopes = direct_owned_write_scopes(temp.path(), &job).unwrap();
    let (execution, written) = execute_write_scoped_worker_direct(
        temp.path(),
        "Write a poem.",
        &JsonValue::Null,
        &scopes,
        Uuid::new_v4(),
        &config,
    )
    .await
    .unwrap();
    assert!(written.is_empty());
    assert!(!temp.path().join("poem.txt").exists());
    assert!(
        user_input_request::from_artifacts(&job, &execution.artifacts)
            .unwrap()
            .is_some()
    );
    assert!(
        execution.final_messages.is_empty(),
        "only the controller publishes the input card"
    );

    fs::write(temp.path().join("source.txt"), "complete file").unwrap();
    let read_job = read_only_worker(&["source.txt"]);
    let observation = build_scoped_worker_path_observation(temp.path(), &read_job).unwrap();
    let execution = execute_preobserved_scoped_worker_direct(
        "Review.",
        &JsonValue::Null,
        &observation,
        Uuid::new_v4(),
        &config,
    )
    .await
    .unwrap();
    assert_eq!(execution.summary, "Which tone should I use?");
    assert!(
        user_input_request::from_artifacts(&read_job, &execution.artifacts)
            .unwrap()
            .is_some()
    );

    output.lock()["actions"][0]["questions"] = json!([]);
    output.lock()["files"] = json!([{"path":"poem.txt", "content":"must not be written"}]);
    assert!(
        execute_write_scoped_worker_direct(
            temp.path(),
            "Write.",
            &JsonValue::Null,
            &scopes,
            Uuid::new_v4(),
            &config
        )
        .await
        .is_err()
    );
    assert!(!temp.path().join("poem.txt").exists());
    *output.lock() = json!({"summary":"Done", "files":[]});
    assert!(
        execute_write_scoped_worker_direct(
            temp.path(),
            "Write.",
            &JsonValue::Null,
            &scopes,
            Uuid::new_v4(),
            &config
        )
        .await
        .is_err(),
        "ordinary completion still requires writes"
    );
    server.abort();
}
