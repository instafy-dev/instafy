//! Native Codex children inside one Instafy job. Only real shell tools create
//! the barrier and result files; a scripted local provider supplies decisions.

use super::*;
use axum::body::{Body, Bytes};
use axum::extract::OriginalUri;
use axum::http::Method;
use axum::routing::any;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_NATIVE_SUBAGENTS_FIXTURE_CHILD";
const PARENT: &str = "NATIVE_PARENT_FIXTURE_716";
const CHILDREN: [&str; 2] = ["NATIVE_CHILD_ALPHA_716", "NATIVE_CHILD_BETA_716"];
const UPSTREAM_KEY: &str = "inert-native-subagent-provider-key";
const TOKENS: u64 = 80;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Case {
    Complete,
    Cancel,
    ReturnEarly,
    #[cfg(feature = "code-mode-host")]
    CompleteV2,
    #[cfg(feature = "code-mode-host")]
    CancelV2,
    #[cfg(feature = "code-mode-host")]
    ReturnEarlyV2,
}

impl Case {
    fn name(self) -> &'static str {
        match self {
            Self::Complete => {
                "native_subagents::native_children_overlap_under_one_scoped_job_and_honor_capacity"
            }
            Self::Cancel => {
                "native_subagents::parent_cancellation_stops_native_children_and_their_tools"
            }
            Self::ReturnEarly => "native_subagents::parent_return_stops_unfinished_native_children",
            #[cfg(feature = "code-mode-host")]
            Self::CompleteV2 => {
                "native_subagents::code_mode_children_overlap_under_one_scoped_job_and_honor_capacity"
            }
            #[cfg(feature = "code-mode-host")]
            Self::CancelV2 => {
                "native_subagents::code_mode_parent_cancellation_stops_native_children"
            }
            #[cfg(feature = "code-mode-host")]
            Self::ReturnEarlyV2 => {
                "native_subagents::code_mode_parent_return_stops_unfinished_native_children"
            }
        }
    }

    fn code_mode(self) -> bool {
        #[cfg(feature = "code-mode-host")]
        if matches!(
            self,
            Self::CompleteV2 | Self::CancelV2 | Self::ReturnEarlyV2
        ) {
            return true;
        }
        false
    }

    fn model(self) -> &'static str {
        if self.code_mode() {
            "gpt-5.6-sol"
        } else {
            "gpt-5.5"
        }
    }

    fn completes(self) -> bool {
        self == Self::Complete || {
            #[cfg(feature = "code-mode-host")]
            {
                self == Self::CompleteV2
            }
            #[cfg(not(feature = "code-mode-host"))]
            {
                false
            }
        }
    }

    fn cancels(self) -> bool {
        self == Self::Cancel || {
            #[cfg(feature = "code-mode-host")]
            {
                self == Self::CancelV2
            }
            #[cfg(not(feature = "code-mode-host"))]
            {
                false
            }
        }
    }
}

#[test]
fn native_children_overlap_under_one_scoped_job_and_honor_capacity() -> Result<()> {
    run(Case::Complete)
}
#[test]
fn parent_cancellation_stops_native_children_and_their_tools() -> Result<()> {
    run(Case::Cancel)
}
#[test]
fn parent_return_stops_unfinished_native_children() -> Result<()> {
    run(Case::ReturnEarly)
}

#[cfg(feature = "code-mode-host")]
#[test]
fn code_mode_children_overlap_under_one_scoped_job_and_honor_capacity() -> Result<()> {
    run(Case::CompleteV2)
}
#[cfg(feature = "code-mode-host")]
#[test]
fn code_mode_parent_cancellation_stops_native_children() -> Result<()> {
    run(Case::CancelV2)
}
#[cfg(feature = "code-mode-host")]
#[test]
fn code_mode_parent_return_stops_unfinished_native_children() -> Result<()> {
    run(Case::ReturnEarlyV2)
}

fn run(case: Case) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        if case.code_mode() {
            stage_code_mode_host()?;
        }
        return run_isolated_fixture(CHILD, case.name(), "native-subagents");
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("native-subagents-proxy".into())
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
        .map_err(|_| anyhow::anyhow!("native-subagent fixture panicked"))?
}

/// Match the existing proxy_retry_budget harness: Cargo puts tests in deps,
/// whereas the packaged companion host is built in the enclosing profile dir.
fn stage_code_mode_host() -> Result<()> {
    static STAGED: std::sync::OnceLock<std::result::Result<(), String>> =
        std::sync::OnceLock::new();
    STAGED.get_or_init(|| {
        let stage = || -> Result<()> {
            let executable = std::env::current_exe()?;
            let deps = executable.parent().context("test binary directory")?;
            let name = runtime_agent::code_mode_host::EXECUTABLE_NAME;
            let built = deps.parent().context("Cargo profile directory")?.join(name);
            anyhow::ensure!(
                built.is_file(),
                "native V2 fixture needs the packaged host; run cargo build --features code-mode-host -p runtime-agent -p codex-code-mode-host"
            );
            let staged = deps.join(name);
            let _ = fs::remove_file(&staged);
            if fs::hard_link(&built, &staged).is_err() {
                fs::copy(&built, &staged)?;
            }
            Ok(())
        };
        stage().map_err(|error| format!("{error:#}"))
    }).clone().map_err(anyhow::Error::msg)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Surface {
    V1,
    V2,
}

struct Provider {
    case: Case,
    workspace: PathBuf,
    calls: StdMutex<[Vec<Value>; 3]>,
    surface: StdMutex<Option<Surface>>,
    capacity_rejected: AtomicBool,
    child_finals: [AtomicBool; 2],
    errors: StdMutex<Vec<String>>,
}

fn input_text(body: &Value) -> String {
    body["input"].to_string()
}
/// The run-instruction blocks of a request: Codex's developer messages, which the proxy carries
/// in the user-role instruction message it puts first.
fn run_instruction_blocks(body: &Value) -> Vec<String> {
    let first = &body["input"][0];
    if first["role"] != "user" {
        return Vec::new();
    }
    let text = first["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    text.split("<instafy_run_instructions>")
        .skip(1)
        .filter_map(|rest| rest.split_once("</instafy_run_instructions>"))
        .map(|(block, _)| block.trim().to_string())
        .collect()
}
fn output(body: &Value, call_id: &str) -> Option<String> {
    body["input"]
        .as_array()?
        .iter()
        .rev()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
        .map(|item| {
            item["output"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| item["output"].to_string())
        })
}
fn surface_from_tools(value: &Value) -> Option<Surface> {
    match value {
        Value::Object(object) => {
            if object.get("name").and_then(Value::as_str) == Some("multi_agent_v1") {
                return Some(Surface::V1);
            }
            if object.get("name").and_then(Value::as_str) == Some("collaboration") {
                return Some(Surface::V2);
            }
            object.values().find_map(surface_from_tools)
        }
        Value::Array(items) => items.iter().find_map(surface_from_tools),
        _ => None,
    }
}
fn call(namespace: Option<&str>, name: &str, id: &str, args: Value) -> Value {
    let mut value = json!({"id":format!("tool_{id}"),"type":"function_call","name":name,"call_id":id,"status":"completed","arguments":args.to_string()});
    if let Some(namespace) = namespace {
        value["namespace"] = json!(namespace);
    }
    value
}
fn shell_call(case: Case, name: &str, id: &str, args: Value) -> Value {
    if case.code_mode() {
        json!({
            "id": format!("tool_{id}"),
            "type": "custom_tool_call",
            "call_id": id,
            "name": "exec",
            "input": format!("text(await tools.{name}({args}));"),
        })
    } else {
        call(None, name, id, args)
    }
}

fn agent_call(surface: Surface, name: &str, id: &str, args: Value) -> Value {
    call(
        Some(match surface {
            Surface::V1 => "multi_agent_v1",
            Surface::V2 => "collaboration",
        }),
        name,
        id,
        args,
    )
}
fn final_item(text: &str) -> Value {
    json!({"id":format!("msg_{}",Uuid::new_v4()),"type":"message","role":"assistant","status":"completed","phase":"final_answer","content":[{"type":"output_text","text":json!({"summary":text,"code":"","files":[],"actions":[]}).to_string()}]})
}
fn response(state: &Provider, items: Vec<Value>) -> axum::response::Response {
    Json(json!({"id":format!("resp_{}",Uuid::new_v4()),"object":"response","status":"completed","model":state.case.model(),"output":items,"usage":{"input_tokens":70,"output_tokens":10,"total_tokens":TOKENS}})).into_response()
}
fn reject(state: &Provider, text: &str) -> axum::response::Response {
    state.errors.lock().unwrap().push(text.to_owned());
    (StatusCode::BAD_REQUEST, text.to_owned()).into_response()
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {UPSTREAM_KEY}").as_str())
    {
        return reject(&state, "wrong upstream credential");
    }
    let text = input_text(&body);
    let lane = if text.contains(PARENT) {
        0
    } else if text.contains(CHILDREN[0]) {
        1
    } else if text.contains(CHILDREN[1]) {
        2
    } else {
        return reject(&state, "request has no known native thread prompt");
    };
    let index = {
        let mut calls = state.calls.lock().unwrap();
        let index = calls[lane].len();
        calls[lane].push(body.clone());
        index
    };
    if index > 15 {
        return reject(&state, "native fixture exceeded bounded request count");
    };
    if lane > 0 {
        let n = lane - 1;
        if index == 0 {
            let cmd = format!(
                "set -eu\ntest -z \"${{RUNTIME_ACCESS_TOKEN:-}}\"\ntest \"${{PROJECT_ID:-}}\" = '{}'\n(while [ ! -f release ]; do sleep 0.02; done; printf child > descendant-{n}) &\nchild=$!\nprintf started > started-{n}\nwait \"$child\"\nprintf poem-{n} > poem-{n}.txt\nprintf ACTUAL_NATIVE_CHILD_{n}",
                std::env::var("PROJECT_ID").unwrap()
            );
            return response(
                &state,
                vec![shell_call(
                    state.case,
                    "exec_command",
                    &format!("child_exec_{n}"),
                    json!({"cmd":cmd,"yield_time_ms":10000,"max_output_tokens":128}),
                )],
            );
        }
        let outputs = body["input"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| {
                matches!(
                    v["type"].as_str(),
                    Some("function_call_output" | "custom_tool_call_output")
                )
            })
            .map(|v| v["output"].to_string())
            .collect::<Vec<_>>()
            .join("\n");
        if outputs.contains(&format!("ACTUAL_NATIVE_CHILD_{n}")) {
            state.child_finals[n].store(true, Ordering::SeqCst);
            return response(&state, vec![final_item(&format!("child {n} completed"))]);
        }
        if let Some((_, tail)) = outputs.rsplit_once("session ID ") {
            let digits = tail
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>();
            if let Ok(id) = digits.parse::<u64>() {
                return response(
                    &state,
                    vec![shell_call(
                        state.case,
                        "write_stdin",
                        &format!("poll_{n}_{index}"),
                        json!({"session_id":id,"chars":"","yield_time_ms":1000,"max_output_tokens":128}),
                    )],
                );
            }
        }
        return reject(
            &state,
            "child shell failed to produce witness or running session",
        );
    }
    let discovered =
        surface_from_tools(&body["tools"]).or_else(|| surface_from_tools(&body["input"]));
    let surface = if let Some(surface) = discovered {
        *state.surface.lock().unwrap() = Some(surface);
        surface
    } else if index == 0 && body["tools"].to_string().contains("tool_search") {
        return response(
            &state,
            vec![
                json!({"id":"discover_native_agents","type":"tool_search_call","call_id":"discover_native_agents","execution":"client","arguments":{"query":"multi_agent_v1 spawn_agent send_input wait_agent close_agent","limit":8}}),
            ],
        );
    } else {
        return reject(
            &state,
            "native collaboration tools absent after supported tool discovery",
        );
    };
    let spawn = |n: usize| {
        let args = match surface {
            Surface::V1 => json!({"message":CHILDREN[n],"fork_context":false}),
            Surface::V2 => {
                json!({"message":CHILDREN[n],"task_name":format!("child_{n}"),"fork_turns":"none"})
            }
        };
        agent_call(surface, "spawn_agent", &format!("spawn_{n}"), args)
    };
    if output(&body, "spawn_0").is_none() && output(&body, "spawn_1").is_none() {
        return response(&state, vec![spawn(0), spawn(1)]);
    }
    if output(&body, "capacity_probe").is_none() {
        if output(&body, "spawn_0").is_none() || output(&body, "spawn_1").is_none() {
            return reject(&state, "root did not receive both native spawn results");
        }
        let args = match surface {
            Surface::V1 => json!({"message":"MUST_NOT_START_CAPACITY_CHILD","fork_context":false}),
            Surface::V2 => {
                json!({"message":"MUST_NOT_START_CAPACITY_CHILD","task_name":"over_capacity","fork_turns":"none"})
            }
        };
        return response(
            &state,
            vec![agent_call(surface, "spawn_agent", "capacity_probe", args)],
        );
    }
    let cap = output(&body, "capacity_probe").unwrap();
    if !cap.contains("limit") {
        return reject(
            &state,
            "third child was not rejected by configured native capacity",
        );
    }
    state.capacity_rejected.store(true, Ordering::SeqCst);
    if !state.case.completes() && !state.case.cancels() {
        let ready = tokio::time::timeout(Duration::from_secs(20), async {
            while !(0..2).all(|n| state.workspace.join(format!("started-{n}")).is_file()) {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if ready.is_err() {
            return reject(&state, "children did not reach barrier before early return");
        }
        return response(
            &state,
            vec![final_item(
                "parent deliberately returned before its children finished",
            )],
        );
    }
    let finished = (0..2).all(|n| {
        state.workspace.join(format!("poem-{n}.txt")).is_file()
            && state.child_finals[n].load(Ordering::SeqCst)
    });
    if finished {
        return response(&state, vec![final_item("native children completed")]);
    }
    let args = match surface {
        Surface::V1 => {
            let ids = (0..2)
                .filter_map(|n| {
                    output(&body, &format!("spawn_{n}"))
                        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                        .and_then(|v| v["agent_id"].as_str().map(str::to_owned))
                })
                .collect::<Vec<_>>();
            if ids.len() != 2 {
                return reject(&state, "native spawn IDs absent");
            };
            json!({"targets":ids,"timeout_ms":10000})
        }
        Surface::V2 => json!({"timeout_ms":10000}),
    };
    response(
        &state,
        vec![agent_call(
            surface,
            "wait_agent",
            &format!("wait_{index}"),
            args,
        )],
    )
}

struct ControllerStub {
    upstream: String,
    model: &'static str,
    credential_id: Uuid,
    requests: StdMutex<Vec<String>>,
}
async fn controller_request(
    State(state): State<Arc<ControllerStub>>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
) -> axum::response::Response {
    state
        .requests
        .lock()
        .unwrap()
        .push(format!("{method} {}", uri.path()));
    if method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    if uri.path() == "/healthz" {
        return (
            StatusCode::OK,
            [("x-instafy-credential-lease-protocol", "1")],
        )
            .into_response();
    }
    if uri.path() == format!("/internal/credentials/{}", state.credential_id)
        && headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some("Bearer inert-credential-lease-key")
    {
        return Json(json!({"kind":"openai_api_key","openaiApiKey":UPSTREAM_KEY,"provider":"openai","upstreamEndpoint":state.upstream,"defaultModel":state.model,"leaseExpiresInSeconds":60,"renewalAuthority":"controller"})).into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}
struct Ingress {
    address: SocketAddr,
    expected_token: String,
    calls: StdMutex<Vec<Value>>,
    bad_auth: AtomicUsize,
}
async fn ingress_request(
    State(state): State<Arc<Ingress>>,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {}", state.expected_token).as_str())
    {
        state.bad_auth.fetch_add(1, Ordering::SeqCst);
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    state.calls.lock().unwrap().push(value);
    let result = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", state.address))
        .bearer_auth(&state.expected_token)
        .header("content-type", "application/json")
        .body(body.to_vec())
        .send()
        .await;
    let Ok(res) = result else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    let Ok(bytes) = res.bytes().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    axum::response::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Body::from(bytes))
        .unwrap()
}

async fn exercise(case: Case) -> Result<()> {
    let _env = env_guard().await;
    let scratch = TempDir::new()?;
    let workspace_root = scratch.path().join("workspaces");
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let runtime_home = scratch.path().join("codex");
    fs::create_dir(&runtime_home)?;
    fs::write(
        runtime_home.join("config.toml"),
        if case.code_mode() {
            "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 3\n"
        } else {
            "[agents]\nmax_concurrent_threads_per_session = 2\n"
        },
    )?;
    let state = Arc::new(Provider {
        case,
        workspace: workspace.clone(),
        calls: StdMutex::new(std::array::from_fn(|_| vec![])),
        surface: StdMutex::new(None),
        capacity_rejected: AtomicBool::new(false),
        child_finals: std::array::from_fn(|_| AtomicBool::new(false)),
        errors: StdMutex::new(vec![]),
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let upstream = listener.local_addr()?;
    let router = Router::new()
        .route("/responses", post(provider_request))
        .with_state(state.clone());
    let provider_task = tokio::spawn(async move { axum::serve(listener, router).await });
    let credential_id = Uuid::new_v4();
    let ctl = Arc::new(ControllerStub {
        upstream: format!("http://{upstream}/responses"),
        model: case.model(),
        credential_id,
        requests: StdMutex::new(vec![]),
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let controller_address = listener.local_addr()?;
    let router = Router::new()
        .fallback(any(controller_request))
        .with_state(ctl.clone());
    let controller_task = tokio::spawn(async move { axum::serve(listener, router).await });
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "true"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "true"),
        ("CONTROLLER_INTERNAL_TOKEN", "inert-controller-internal-key"),
        ("PROXY_CREDENTIAL_LEASE_TOKEN", "inert-credential-lease-key"),
        ("PROXY_SIGNING_SECRET", "inert-native-signer"),
        ("CODEX_MODEL", case.model()),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_PERSIST_STRUCTURED_CONVERSATION_THREAD", "true"),
        ("CODEX_ENABLE_WEB_SEARCH", "false"),
        ("CODEX_RUNTIME_REASONING_EFFORT", "low"),
        ("CODEX_RUN_TIMEOUT_SECONDS", "45"),
        ("CODEX_MAX_RUN_RETRIES", "0"),
        ("RUNTIME_ACCESS_TOKEN", "inert-parent-runtime-private"),
    ] {
        settings.push(EnvGuard::set(key, value));
    }
    settings.push(EnvGuard::set(
        "CONTROLLER_BASE_URL",
        format!("http://{controller_address}"),
    ));
    settings.push(EnvGuard::set("CODEX_HOME", runtime_home.to_string_lossy()));
    settings.push(EnvGuard::set("PROJECT_ID", project_id.to_string()));
    let port = reserve_port()?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let (shutdown, receiver) = oneshot::channel();
    let proxy_task = tokio::spawn(proxy::run_proxy_with_shutdown(address, None, async {
        let _ = receiver.await;
    }));
    let proxy_guard = ChildGuard::new(shutdown);
    wait_for_port(port).await?;
    let job_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"aud":"proxy","project_id":project_id,"runtime_id":runtime_id,"run_id":run_id,"job_id":job_id,"lease_attempt":1,"credential_id":credential_id,"exp":chrono::Utc::now().timestamp()+300}),
        &jsonwebtoken::EncodingKey::from_secret(b"inert-native-signer"),
    )?;
    let ingress = Arc::new(Ingress {
        address,
        expected_token: token.clone(),
        calls: StdMutex::new(vec![]),
        bad_auth: AtomicUsize::new(0),
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let ingress_address = listener.local_addr()?;
    let router = Router::new()
        .route("/v1/responses", post(ingress_request))
        .with_state(ingress.clone());
    let ingress_task = tokio::spawn(async move { axum::serve(listener, router).await });
    let config = Arc::new(Config {
        controller_base_url: Url::parse(&format!("http://{controller_address}"))?,
        controller_jwks_url: Url::parse(&format!(
            "http://{controller_address}/.well-known/jwks.json"
        ))?,
        project_id,
        runtime_id: None,
        runtime_lease_id: None,
        provider: "test-runtime".into(),
        runtime_version: "test".into(),
        capabilities: json!({}),
        metadata: json!({}),
        lease_scope: None,
        workspace_manifest: None,
        tenant_projects: vec![],
        parent_lease_id: None,
        poll_interval: Duration::from_millis(10),
        lease_wait: Duration::ZERO,
        lease_max_jobs: 1,
        lease_seconds: 30,
        heartbeat_seconds: 30,
        workspace_root,
        project_workspace_override: None,
        strict_mode: false,
        dev_isolation_mode: false,
        display_name: None,
        origin: None,
        codex_bin: None,
        require_codex_bin: false,
        runtime_access_token: None,
        parent_dispositions_runtime_on_shutdown: false,
    });
    let job = LeaseJob {
        id: job_id,
        intent: Some("feature".into()),
        project_id: Some(project_id),
        run_id: Some(run_id),
        conversation_id: Some(Uuid::new_v4()),
        session_id: None,
        credential_id: Some(credential_id),
        payload: json!({"prompt_text":format!("{PARENT}: delegate two independent local tasks and report their results."),"metadata":{"execution_mode":"apply","agentRoutingPreflight":{},"runtimeExpectations":{"workspaceFileChanges":false,"commandExecution":false,"genericMcpToolExecution":false}}}),
        proxy: Some(runtime_contracts::ProxyEnvelopePayload {
            url: format!("http://{ingress_address}"),
            token,
            expires_at: None,
        }),
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
        lease_attempts: 1,
        grants: Vec::new(),
        grant_token: None,
    };
    let cancel = JobCancelSignal::new();
    let cancel_run = cancel.clone();
    let mut task = tokio::spawn(async move {
        JobProcessor::new(config)
            .run_apply_job(
                &registration_for_live(runtime_id),
                &job,
                false,
                None,
                Some(cancel_run),
                None,
            )
            .await
    });
    let result = async {
        tokio::time::timeout(Duration::from_secs(35), async {
            loop {
                let both_started = (0..2)
                    .all(|n| workspace.join(format!("started-{n}")).is_file());
                if both_started && state.capacity_rejected.load(Ordering::SeqCst) {
                    break;
                }
                anyhow::ensure!(
                    !task.is_finished(),
                    "parent exited before both native tools started; provider errors: {:?}",
                    state.errors.lock().unwrap()
                );
                sleep(Duration::from_millis(20)).await;
            }
            Ok::<(), anyhow::Error>(())
        })
        .await
        .context("native children must both reach unreleased tool barrier")??;

        anyhow::ensure!(
            (0..2).all(|n| !workspace.join(format!("poem-{n}.txt")).exists()),
            "tool completed before barrier release"
        );
        if case.completes() {
            fs::write(workspace.join("release"), "release")?;
        } else if case.cancels() {
            cancel.cancel();
        }
        let output = tokio::time::timeout(Duration::from_secs(15), &mut task)
            .await
            .context("parent must finish within shutdown bound")??;
        if case.cancels() {
            let error = output.as_ref().err().context("canceled parent unexpectedly succeeded")?;
            anyhow::ensure!(
                runtime_agent::agent_executor::is_lease_lost(error),
                "parent returned an unrelated failure instead of cancellation: {error:#}"
            );
        } else {
            output.as_ref().map_err(|e| anyhow::anyhow!("parent failed: {e:#}"))?;
        }

        // The parent has returned, but the Tokio runtime, proxy and provider
        // remain alive. Any surviving shell can now leave a concrete witness.
        if !case.completes() {
            fs::write(workspace.join("release"), "release")?;
            sleep(Duration::from_millis(300)).await;
        }
        for n in 0..2 {
            anyhow::ensure!(
                workspace.join(format!("poem-{n}.txt")).exists() == case.completes(),
                "native child {n} wrote after its parent job returned/cancelled"
            );
            anyhow::ensure!(
                workspace.join(format!("descendant-{n}")).exists() == case.completes(),
                "native child {n}'s shell descendant survived its parent job"
            );
        }
        anyhow::ensure!(
            ingress.bad_auth.load(Ordering::SeqCst) == 0,
            "native child changed the scoped parent envelope"
        );
        let requests = ctl.requests.lock().unwrap();
        anyhow::ensure!(
            requests.iter().all(|p| p == "GET /healthz" || p.starts_with("GET /internal/credentials/")),
            "native delegation attempted controller job operations: {requests:?}"
        );
        let calls = state.calls.lock().unwrap();
        anyhow::ensure!(
            !calls[1].is_empty() && !calls[2].is_empty(),
            "provider must observe both native child threads"
        );
        // A native child reads its parent run's instructions once, as the parent's thread does.
        for child in &calls[1..] {
            let blocks = run_instruction_blocks(&child[0]);
            anyhow::ensure!(
                blocks.len() == 1
                    && blocks[0].starts_with("Instafy Studio structured execution run:"),
                "a native child's first request must carry its parent run's instructions once: {blocks:?}"
            );
        }
        anyhow::ensure!(
            ingress.calls.lock().unwrap().len() == calls.iter().map(Vec::len).sum::<usize>(),
            "every native root/child provider request must traverse the scoped Instafy proxy"
        );
        anyhow::ensure!(state.errors.lock().unwrap().is_empty(), "provider rejected fixture requests");
        if case.completes() {
            anyhow::ensure!(
                state.child_finals.iter().all(|done| done.load(Ordering::SeqCst)),
                "both children must observe real command outputs and emit final responses"
            );
        }
        let expected_surface = if case.code_mode() { Surface::V2 } else { Surface::V1 };
        anyhow::ensure!(
            *state.surface.lock().unwrap() == Some(expected_surface),
            "native tool surface does not match the explicit fixture configuration"
        );
        if let Ok(execution) = output {
            let usage = execution.artifacts.iter()
                .find(|a| a["kind"] == "ai/task-usage")
                .context("root diagnostic usage receipt missing")?;
            anyhow::ensure!(
                usage["coverage"] == "root_turns_only",
                "child usage must not be mislabeled as root coverage"
            );
            let reported = usage["calls"].as_array().context("usage calls")?
                .iter().filter_map(|c| c["usage"]["total_tokens"].as_u64()).sum::<u64>();
            anyhow::ensure!(
                reported == calls[0].len() as u64 * TOKENS,
                "root diagnostics must sum only actual root Responses: got {reported}, {} root requests",
                calls[0].len()
            );
            let all = calls.iter().map(Vec::len).sum::<usize>() as u64 * TOKENS;
            anyhow::ensure!(all > reported, "proxy provider receipts must expose the additional child usage");
            eprintln!(
                "native subagents: one Instafy job; root requests={}, child requests={}; root tokens={reported}, all proxy provider tokens={all}",
                calls[0].len(), calls[1].len() + calls[2].len()
            );
        }
        Ok::<(), anyhow::Error>(())
    }.await;
    cancel.cancel();
    let _ = fs::write(workspace.join("release"), "cleanup release");
    if !task.is_finished() {
        let _ = tokio::time::timeout(Duration::from_secs(12), &mut task).await;
    }
    // If a lifecycle regression leaves tools behind, release lets them exit
    // before the failing fixture process is reaped; their writes fail above.
    sleep(Duration::from_millis(400)).await;
    drop(proxy_guard);
    proxy_task.await??;
    ingress_task.abort();
    controller_task.abort();
    provider_task.abort();
    result.context(format!(
        "native provider errors: {:?}",
        state.errors.lock().unwrap()
    ))
}
