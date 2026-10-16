//! Two real native tool turns through the Instafy proxy. The provider fixture
//! supplies tool calls, but only the actual shell tools create the witnesses.

use super::*;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_ISOLATED_TOOL_WORKERS_FIXTURE_CHILD";

#[derive(Clone, Copy)]
enum Case {
    Complete,
    CancelFirst,
}

impl Case {
    fn test_name(self) -> &'static str {
        match self {
            Self::Complete => {
                "isolated_tool_workers::native_workers_overlap_real_tools_without_sharing_credentials"
            }
            Self::CancelFirst => {
                "isolated_tool_workers::canceling_one_native_worker_stops_its_tool_and_preserves_its_sibling"
            }
        }
    }
}

#[test]
fn native_workers_overlap_real_tools_without_sharing_credentials() -> Result<()> {
    run_case(Case::Complete)
}

#[test]
fn canceling_one_native_worker_stops_its_tool_and_preserves_its_sibling() -> Result<()> {
    run_case(Case::CancelFirst)
}

fn run_case(case: Case) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, case.test_name(), "isolated-tool-workers");
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("isolated-tool-workers-proxy".into())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(4)
                .thread_stack_size(STACK)
                .build()?
                .block_on(exercise(case))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("isolated tool workers fixture panicked"))?
}

struct Provider {
    requests: StdMutex<[Vec<Value>; 2]>,
    outside_file: PathBuf,
    host_auth: PathBuf,
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

fn tool_outputs(body: &Value) -> String {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| item["output"].to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

fn response(item: Value) -> axum::response::Response {
    Json(json!({
        "id":format!("resp_{}",Uuid::new_v4()),"object":"response","status":"completed","model":"gpt-5.5",
        "output":[item],"usage":{"input_tokens":70,"output_tokens":10,"total_tokens":80}
    }))
    .into_response()
}

fn call(name: &str, arguments: Value) -> Value {
    let id = Uuid::new_v4().simple().to_string();
    json!({"id":format!("tool_{id}"),"type":"function_call","name":name,
        "call_id":format!("call_{id}"),"status":"completed","arguments":arguments.to_string()})
}

fn final_answer(lane: usize) -> Value {
    json!({"id":format!("msg_{}",Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer","content":[{"type":"output_text","text":json!({
            "summary":format!("Worker {lane} completed its real tool."),"code":"","files":[],"actions":[]
        }).to_string()}]})
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let lane = match headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
    {
        Some("Bearer inert-provider-lane-0") => 0,
        Some("Bearer inert-provider-lane-1") => 1,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                "fixture provider credential mismatch",
            )
                .into_response();
        }
    };
    let index = {
        let mut requests = state.requests.lock().unwrap();
        let index = requests[lane].len();
        requests[lane].push(body.clone());
        index
    };
    if index == 0 {
        // A background descendant waits too, so canceling only the outer
        // shell/worker cannot accidentally pass the cancellation case.
        let outside = shell_quote(&state.outside_file);
        let host_auth = shell_quote(&state.host_auth);
        let command = format!(
            "set -eu\n\
             if cat {outside} >/dev/null 2>&1; then exit 51; fi\n\
             if cat {host_auth} >/dev/null 2>&1; then exit 52; fi\n\
             if printf forbidden > {outside} 2>/dev/null; then exit 53; fi\n\
             test \"$FIXTURE_JOB_SENTINEL\" = 'job-secret-{lane}'\n\
             test \"$CONTROLLER_ACCESS_TOKEN\" = 'inert-controller-lane-{lane}'\n\
             test -z \"${{RUNTIME_ACCESS_TOKEN:-}}\"\n\
             test -z \"${{OPENAI_API_KEY:-}}\"\n\
             test -z \"${{CODEX_API_KEY:-}}\"\n\
             (while [ ! -f release ]; do sleep 0.02; done; printf 'descendant-{lane}' > descendant.txt) &\n\
             child=$!\n\
             printf started > started\n\
             wait \"$child\" || exit $?\n\
             printf '%s' \"$FIXTURE_JOB_SENTINEL\" > result.txt\n\
             printf 'ACTUAL_TOOL_WITNESS_{lane}'"
        );
        return response(call(
            "exec_command",
            json!({"cmd":command,"yield_time_ms":10000,"max_output_tokens":128}),
        ));
    }
    let outputs = tool_outputs(&body);
    if outputs.contains(&format!("ACTUAL_TOOL_WITNESS_{lane}")) {
        return response(final_answer(lane));
    }
    // Unified exec can yield while the other child initializes. Keep polling
    // the real shell session rather than pretending the fixture tool finished.
    if let Some(tail) = outputs
        .rsplit("session ID ")
        .next()
        .filter(|_| outputs.contains("session ID "))
    {
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(session_id) = digits.parse::<u64>() {
            return response(call(
                "write_stdin",
                json!({"session_id":session_id,"chars":"","yield_time_ms":1000,"max_output_tokens":128}),
            ));
        }
    }
    (
        StatusCode::BAD_REQUEST,
        "native tool did not return the expected witness or running session",
    )
        .into_response()
}

async fn wait_for_both_started(
    workspaces: &[PathBuf; 2],
    worker_finished: impl Fn() -> bool,
) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if workspaces.iter().all(|path| path.join("started").is_file()) {
                return Ok::<(), anyhow::Error>(());
            }
            anyhow::ensure!(
                !worker_finished(),
                "a worker exited before both real tools reached the barrier"
            );
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .context(
        "both real tools must start before either barrier is released; serialization cannot pass",
    )??;
    Ok(())
}

async fn exercise(case: Case) -> Result<()> {
    use runtime_agent::isolated_tool_worker::{IsolatedToolWorkerRequest, run_with_program};
    let _env = env_guard().await;
    let scratch = TempDir::new()?;
    let outside_file = scratch.path().join("outside-protected.txt");
    fs::write(&outside_file, "outside-preserved")?;
    // HOME belongs to run_isolated_fixture, never the developer's account.
    let host_auth = PathBuf::from(std::env::var_os("HOME").context("owned fixture HOME")?)
        .join(".codex/auth.json");
    fs::create_dir_all(host_auth.parent().unwrap())?;
    fs::write(
        &host_auth,
        r#"{"tokens":{"access_token":"inert-host-auth-must-stay-private"}}"#,
    )?;
    let state = Arc::new(Provider {
        requests: StdMutex::new(std::array::from_fn(|_| Vec::new())),
        outside_file: outside_file.clone(),
        host_auth: host_auth.clone(),
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let provider_address = listener.local_addr()?;
    let app = Router::new()
        .route("/responses", post(provider_request))
        .with_state(state.clone());
    let provider_task = tokio::spawn(async move { axum::serve(listener, app).await });
    let _require_auth = EnvGuard::set("PROXY_REQUIRE_CONTROLLER_AUTH", "false");
    let _require_claim = EnvGuard::set("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false");
    let _parent_token = EnvGuard::set(
        "RUNTIME_ACCESS_TOKEN",
        "inert-parent-runtime-must-not-reach-tools",
    );
    let mut proxies = Vec::new();
    let mut handles = Vec::new();
    let workspaces: [PathBuf; 2] =
        std::array::from_fn(|lane| scratch.path().join(format!("workspace-{lane}")));
    let cancellations: [JobCancelSignal; 2] = std::array::from_fn(|_| JobCancelSignal::new());
    for lane in 0..2 {
        fs::create_dir_all(&workspaces[lane])?;
        fs::create_dir(scratch.path().join(format!("state-{lane}")))?;
        let port = reserve_port()?;
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let credentials = auth::Credentials::ApiKey {
            key: format!("inert-provider-lane-{lane}"),
            endpoint: Some(format!("http://{provider_address}/responses")),
            default_model: Some("gpt-5.5".into()),
        };
        let (shutdown, receiver) = oneshot::channel();
        let task = tokio::spawn(proxy::run_proxy_with_shutdown(
            address,
            Some(credentials),
            async {
                let _ = receiver.await;
            },
        ));
        proxies.push((ChildGuard::new(shutdown), task));
        wait_for_port(port).await?;
        let request = IsolatedToolWorkerRequest {
            workspace_dir: workspaces[lane].clone(),
            state_dir: scratch.path().join(format!("state-{lane}")),
            prompt: format!(
                "Complete worker {lane}'s local fixture using the supplied shell tool, then summarize."
            ),
            project_id: Uuid::new_v4(),
            conversation_id: None,
            job_id: Uuid::new_v4(),
            proxy_base_url: format!("http://{address}"),
            proxy_token: format!("inert-proxy-lane-{lane}"),
            controller_base_url: "http://127.0.0.1:9".into(),
            controller_token: Some(format!("inert-controller-lane-{lane}")),
            controller_token_scopes: vec!["agent.message".into()],
            controller_token_expires_at: None,
            job_environment: HashMap::from([(
                "FIXTURE_JOB_SENTINEL".into(),
                format!("job-secret-{lane}"),
            )]),
            model: Some("gpt-5.5".into()),
            reasoning_effort: Some(codex_protocol::openai_models::ReasoningEffort::Low),
        };
        let cancel = cancellations[lane].clone();
        handles.push(Some(tokio::spawn(async move {
            let mut events = Vec::new();
            let output = run_with_program(
                Path::new(env!("CARGO_BIN_EXE_runtime-agent")),
                request,
                &mut |event| {
                    events.push(event.clone());
                    Ok(())
                },
                cancel,
            )
            .await;
            (output, events)
        })));
    }

    let result = async {
        wait_for_both_started(&workspaces, || {
            handles.iter().flatten().any(|handle| handle.is_finished())
        })
        .await?;
        for path in &workspaces {
            anyhow::ensure!(
                !path.join("result.txt").exists(),
                "neither waiting tool may finish before release"
            );
        }
        if matches!(case, Case::CancelFirst) {
            cancellations[0].cancel();
            let (result, _) =
                tokio::time::timeout(Duration::from_secs(12), handles[0].as_mut().unwrap())
                    .await
                    .context("canceled tool worker must terminate promptly")??;
            handles[0] = None;
            let error = result
                .err()
                .context("the canceled worker must not succeed")?;
            anyhow::ensure!(
                error.to_string().contains("lease lost"),
                "cancel must finish cleanly as lease loss, not a worker/cleanup failure: {error:#}"
            );
        }
        // The fixture controls release only; it never creates a tool witness or result.
        for path in &workspaces {
            fs::write(path.join("release"), "release")?;
        }
        for handle in &mut handles {
            if let Some(pending) = handle.as_mut() {
                let (output, _) = tokio::time::timeout(Duration::from_secs(30), pending)
                    .await
                    .context("worker must finish after release")??;
                *handle = None;
                output?;
            }
        }
        sleep(Duration::from_millis(150)).await;
        for lane in 0..2 {
            if lane == 0 && matches!(case, Case::CancelFirst) {
                anyhow::ensure!(
                    !workspaces[lane].join("result.txt").exists(),
                    "canceled tool wrote after its worker returned"
                );
                anyhow::ensure!(
                    !workspaces[lane].join("descendant.txt").exists(),
                    "canceled descendant survived its worker"
                );
                continue;
            }
            anyhow::ensure!(
                fs::read_to_string(workspaces[lane].join("result.txt"))?
                    == format!("job-secret-{lane}"),
                "worker secret was mixed between jobs"
            );
            anyhow::ensure!(
                fs::read_to_string(workspaces[lane].join("descendant.txt"))?
                    == format!("descendant-{lane}"),
                "tool descendant did not complete its own lane"
            );
            let requests = state.requests.lock().unwrap();
            let outputs = requests[lane]
                .iter()
                .map(tool_outputs)
                .collect::<Vec<_>>()
                .join("\n");
            anyhow::ensure!(outputs.contains(&format!("ACTUAL_TOOL_WITNESS_{lane}")));
            anyhow::ensure!(
                !outputs.contains(&format!("ACTUAL_TOOL_WITNESS_{}", 1 - lane)),
                "sibling tool result leaked between native turns"
            );
        }
        anyhow::ensure!(
            fs::read_to_string(&outside_file)? == "outside-preserved",
            "outside workspace sentinel changed"
        );
        anyhow::ensure!(
            fs::read_to_string(&host_auth)?.contains("inert-host-auth-must-stay-private"),
            "host auth sentinel changed"
        );
        Ok::<(), anyhow::Error>(())
    }
    .await;
    for cancel in &cancellations {
        cancel.cancel();
    }
    let mut worker_errors = Vec::new();
    for handle in handles.into_iter().flatten() {
        let (output, _) = tokio::time::timeout(Duration::from_secs(15), handle)
            .await
            .context("fixture cleanup must drain worker children")??;
        if let Err(error) = output {
            worker_errors.push(format!("{error:#}"));
        }
    }
    for (guard, task) in proxies {
        drop(guard);
        task.await??;
    }
    provider_task.abort();
    if result.is_err() {
        let requests = state.requests.lock().unwrap();
        let diagnostics = requests
            .iter()
            .enumerate()
            .map(|(lane, requests)| {
                let outputs = requests.last().map(tool_outputs).unwrap_or_default();
                format!(
                    "lane {lane}: {} provider requests; last tool output: {}",
                    requests.len(),
                    outputs.chars().take(1200).collect::<String>()
                )
            })
            .collect::<Vec<_>>();
        return result.context(format!(
            "worker errors={worker_errors:?}; {}",
            diagnostics.join("; ")
        ));
    }
    result
}
