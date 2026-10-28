//! `runtime-agent provider-mcp`, a granted turn's broker, as Codex runs it: a stdio MCP server in
//! its own process group, configured only by its environment, in front of a stub controller.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use runtime_agent::mcp_process_groups::REGISTRY_ENV;
use runtime_agent::provider_mcp::{
    CONTROLLER_URL_ENV, GRANTS_ENV, MCP_COMMAND, MESSAGE_SEARCH_TOOL, PROJECT_ID_ENV, TOKEN_ENV,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use uuid::Uuid;

const GRANT_TOKEN: &str = "grant-token-of-the-turn";
const DEVICE_INSTRUCTIONS: &str = "Use the example device only when the person asks for it.";
const LAMP_INSTRUCTIONS: &str = "The lamp dims in steps of ten.";

#[derive(Default)]
struct Controller {
    calls: Mutex<Vec<(Option<String>, String, Value)>>,
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn provider_tool_call(
    State(controller): State<Arc<Controller>>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> axum::response::Response {
    controller.calls.lock().unwrap().push((
        bearer(&headers),
        format!("call {project_id}"),
        body.clone(),
    ));
    if body["arguments"]["to"] == json!(-1) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "message": "not this one", "code": "grant_not_held" })),
        )
            .into_response();
    }
    axum::Json(json!({
        "ok": true,
        "outcome": "succeeded",
        "tool": body["name"],
        "arguments": body["arguments"],
    }))
    .into_response()
}

async fn search_messages(
    State(controller): State<Arc<Controller>>,
    headers: HeaderMap,
    Query(query): Query<BTreeMap<String, String>>,
) -> axum::response::Response {
    controller
        .calls
        .lock()
        .unwrap()
        .push((bearer(&headers), "search".to_string(), json!(query)));
    axum::Json(json!({
        "matches": [{
            "conversationTitle": "Kitchen",
            "createdAt": "2026-10-14T12:00:00Z",
            "role": "user",
            "snippet": "the red cup is on the left",
        }],
        "nextCursor": null,
        "hasMore": false,
    }))
    .into_response()
}

async fn start_controller() -> (Arc<Controller>, String, tokio::task::JoinHandle<()>) {
    let controller = Arc::new(Controller::default());
    let app = Router::new()
        .route(
            "/projects/:project_id/provider-tools/call",
            post(provider_tool_call),
        )
        .route("/search/messages", get(search_messages))
        .with_state(controller.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the stub controller");
    let address = listener.local_addr().expect("stub address");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (controller, format!("http://{address}/"), server)
}

/// Two grants as the broker gets them: the device's, and a lamp's that also names the device's
/// `example.lamp.on`, which neither then serves.
fn grants() -> Value {
    let tool = |name: &str, description: &str, properties: Value| {
        json!({ "name": name, "description": description,
                "inputSchema": { "type": "object", "properties": properties } })
    };
    json!([
        {
            "providerId": "example-device",
            "instructions": DEVICE_INSTRUCTIONS,
            "tools": [
                tool("example.state.read", "Reads the device's state.", json!({})),
                tool("example.part.move", "Moves the device's part.",
                     json!({ "to": { "type": "number" } })),
                tool("example.lamp.on", "Turns the device's lamp on.", json!({})),
            ],
        },
        {
            "providerId": "example-lamp",
            "instructions": LAMP_INSTRUCTIONS,
            "tools": [
                tool("example.lamp.on", "Turns the lamp on.", json!({})),
                tool("example.lamp.dim", "Dims the lamp.", json!({ "to": { "type": "number" } })),
            ],
        },
    ])
}

struct Broker {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Broker {
    /// Spawns the broker as Codex does: a new process group and only the given environment.
    fn spawn(environment: &[(&str, String)]) -> Child {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_runtime-agent"));
        command
            .arg(MCP_COMMAND)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in environment {
            command.env(key, value);
        }
        command.as_std_mut().process_group(0);
        command.spawn().expect("spawn provider-mcp")
    }

    fn start(environment: &[(&str, String)]) -> Self {
        let mut child = Self::spawn(environment);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout")).lines();
        Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        }
    }

    async fn send(&mut self, message: Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .expect("write to provider-mcp");
        self.stdin.flush().await.expect("flush");
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        loop {
            let line = tokio::time::timeout(Duration::from_secs(20), self.stdout.next_line())
                .await
                .expect("provider-mcp answers")
                .expect("read provider-mcp")
                .expect("provider-mcp is still running");
            let message: Value = serde_json::from_str(&line).expect("JSON-RPC line");
            if message["id"] == json!(id) {
                return message;
            }
        }
    }

    async fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }
}

fn environment(
    controller_url: &str,
    project_id: Uuid,
    registry: &std::path::Path,
) -> Vec<(&'static str, String)> {
    vec![
        (GRANTS_ENV, grants().to_string()),
        (TOKEN_ENV, GRANT_TOKEN.to_string()),
        (CONTROLLER_URL_ENV, controller_url.to_string()),
        (PROJECT_ID_ENV, project_id.to_string()),
        (REGISTRY_ENV, registry.to_string_lossy().into_owned()),
    ]
}

#[tokio::test]
async fn the_broker_serves_its_grants_tools_and_sends_each_call_with_the_turns_token() {
    let (controller, controller_url, server) = start_controller().await;
    let project_id = Uuid::new_v4();
    let registry = tempfile::tempdir().expect("registry");
    let mut broker = Broker::start(&environment(&controller_url, project_id, registry.path()));

    let initialized = broker
        .request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "provider-mcp-test", "version": "1" },
            }),
        )
        .await;
    // Codex shows a server's instructions to the model as its tools' namespace description.
    assert_eq!(
        initialized["result"]["instructions"],
        json!(format!("{DEVICE_INSTRUCTIONS}\n\n{LAMP_INSTRUCTIONS}")),
        "{initialized}"
    );
    broker
        .send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .await;

    // The broker recorded its own process group before serving.
    let pid = broker.child.id().expect("broker pid");
    let registered: Vec<String> = std::fs::read_dir(registry.path())
        .expect("registry")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(registered, vec![pid.to_string()]);

    let listed = broker.request("tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().expect("tools");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(
        names,
        [
            "example.state.read",
            "example.part.move",
            "example.lamp.dim",
            MESSAGE_SEARCH_TOOL
        ]
    );
    assert_eq!(tools[1]["description"], json!("Moves the device's part."));
    assert_eq!(
        tools[1]["inputSchema"],
        grants()[0]["tools"][1]["inputSchema"]
    );
    assert_eq!(tools[3]["inputSchema"]["required"], json!(["query"]));

    let read = broker.call("example.state.read", json!({})).await;
    assert_eq!(read["result"]["isError"], json!(false), "{read}");
    assert_eq!(
        read["result"]["structuredContent"]["outcome"],
        json!("succeeded")
    );
    let dimmed = broker.call("example.lamp.dim", json!({ "to": 30 })).await;
    assert_eq!(
        dimmed["result"]["structuredContent"]["arguments"],
        json!({ "to": 30 })
    );

    // The controller's refusal reaches the model as an error result naming it.
    let refused = broker.call("example.part.move", json!({ "to": -1 })).await;
    assert_eq!(refused["result"]["isError"], json!(true), "{refused}");
    assert_eq!(refused["result"]["structuredContent"]["status"], json!(403));
    assert_eq!(
        refused["result"]["structuredContent"]["error"]["code"],
        json!("grant_not_held")
    );

    // The broker sends at most its own cap of matches, whatever the turn asks.
    let found = broker
        .call(
            MESSAGE_SEARCH_TOOL,
            json!({ "query": "red cup", "limit": 30 }),
        )
        .await;
    assert_eq!(
        found["result"]["structuredContent"]["matches"][0]["conversationTitle"],
        json!("Kitchen"),
        "{found}"
    );

    // Nothing else is served: an ungranted tool, or one two grants both name.
    for (name, arguments) in [
        ("example.part.erase", json!({})),
        ("example.lamp.on", json!({})),
    ] {
        let answer = broker.call(name, arguments).await;
        assert!(answer.get("error").is_some(), "{name}: {answer}");
    }

    let calls = controller.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 4, "{calls:?}");
    for call in &calls {
        assert_eq!(call.0, Some(format!("Bearer {GRANT_TOKEN}")));
    }
    assert_eq!(calls[0].1, format!("call {project_id}"));
    // The controller's wait ends before Codex gives up on the call, after 20 s.
    let wait = calls[0].2["timeoutMs"].as_u64().unwrap_or(u64::MAX);
    assert!(wait < 20_000, "{wait}");
    assert_eq!(
        calls[0].2,
        json!({
            "providerId": "example-device",
            "name": "example.state.read",
            "arguments": {},
            "timeoutMs": wait,
        })
    );
    assert_eq!(calls[1].2["providerId"], json!("example-lamp"));
    assert_eq!(calls[1].2["name"], json!("example.lamp.dim"));
    assert_eq!(calls[3].1, "search");
    assert_eq!(
        calls[3].2,
        json!({ "q": "red cup", "limit": "8", "projectId": project_id.to_string() })
    );

    drop(broker);
    server.abort();
}

#[tokio::test]
async fn the_broker_serves_nothing_without_its_registry_grants_token_or_own_group() {
    let (controller, controller_url, server) = start_controller().await;
    let project_id = Uuid::new_v4();
    let registry = tempfile::tempdir().expect("registry");
    let full = environment(&controller_url, project_id, registry.path());
    for missing in [REGISTRY_ENV, GRANTS_ENV, TOKEN_ENV, PROJECT_ID_ENV] {
        let environment: Vec<_> = full
            .iter()
            .filter(|(key, _)| *key != missing)
            .cloned()
            .collect();
        let child = Broker::spawn(&environment);
        let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
            .await
            .expect("provider-mcp exits")
            .expect("provider-mcp output");
        assert!(!output.status.success(), "served without {missing}");
        assert!(output.stdout.is_empty(), "answered without {missing}");
    }
    assert!(controller.calls.lock().unwrap().is_empty());
    // A broker that cannot lead its own process group refuses too: here it shares the test's.
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_runtime-agent"));
    command
        .arg(MCP_COMMAND)
        .env_clear()
        .envs(full.iter().map(|(key, value)| (*key, value.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        command.spawn().expect("spawn").wait_with_output(),
    )
    .await
    .expect("provider-mcp exits")
    .expect("output");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("own process group"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.abort();
}
