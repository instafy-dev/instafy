//! Native Responses Lite requests use only inert credentials and loopback upstreams.
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Result;
use axum::extract::{OriginalUri, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use openai_proxy_server::auth::Credentials;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

const LITE_HEADER: &str = "x-openai-internal-codex-responses-lite";

struct TaskGuard(tokio::task::JoinHandle<()>);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn capture_upstream(
    State(captured): State<mpsc::UnboundedSender<(HeaderMap, Value)>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    captured.send((headers, payload.clone())).unwrap();
    let mut response = json!({
        "id": "resp_lite_fixture", "object": "response", "model": payload["model"],
        "status": "completed", "output": [{"type": "message", "role": "assistant",
        "content": [{"type": "output_text", "text": "ok"}]}]
    });
    if payload["include"] == json!(["reasoning.encrypted_content"]) {
        response["output"].as_array_mut().unwrap().insert(
            0,
            json!({"type":"reasoning", "id":"rs_stable", "summary":[],
                "encrypted_content":"inert-encrypted-reasoning-fixture"}),
        );
    }
    if uri.path() == "/backend-api/codex/responses" {
        return (
            [("content-type", "text/event-stream")],
            format!(
                "data: {}\n\n",
                json!({"type": "response.completed", "response": response})
            ),
        )
            .into_response();
    }
    Json(response).into_response()
}

async fn spawn_proxy(credentials: Credentials) -> Result<(SocketAddr, TaskGuard)> {
    let reservation = TcpListener::bind("127.0.0.1:0").await?;
    let addr = reservation.local_addr()?;
    drop(reservation);
    let task = TaskGuard(tokio::spawn(async move {
        run_proxy_with_shutdown(addr, Some(credentials), std::future::pending::<()>())
            .await
            .expect("fixture proxy starts");
    }));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()?;
    for _ in 0..100 {
        if client
            .get(format!("http://{addr}/healthz"))
            .send()
            .await
            .is_ok()
        {
            return Ok((addr, task));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    anyhow::bail!("fixture proxy did not become ready")
}

#[test]
fn responses_lite_preserves_native_items_controls_and_header_on_both_upstreams() -> Result<()> {
    const CHILD: &str = "PROXY_RESPONSES_LITE_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(assert_lite_requests());
    }
    // Exclude developer credentials, proxy settings, and controller configuration.
    let output = std::process::Command::new(std::env::current_exe()?)
        .env_clear()
        .env(CHILD, "1")
        .args([
            "--exact",
            "responses_lite_preserves_native_items_controls_and_header_on_both_upstreams",
        ])
        .output()?;
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn assert_lite_requests() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream = listener.local_addr()?;
    // This credential-free child process owns the environment and its current-thread runtime.
    unsafe {
        std::env::set_var(
            "CODEX_PROXY_CHATGPT_ENDPOINT",
            format!("http://{upstream}/backend-api/codex/responses"),
        );
    }
    let (captured, mut requests) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(capture_upstream))
        .route("/v1/chat/completions", post(capture_upstream))
        .route("/backend-api/codex/responses", post(capture_upstream))
        .with_state(captured);
    let _upstream = TaskGuard(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?;
    for credentials in [
        Credentials::ApiKey {
            key: "fixture-api-key".into(),
            endpoint: Some(format!("http://{upstream}/v1/responses")),
            default_model: None,
        },
        Credentials::ChatGpt {
            access_token: "fixture-access-token".into(),
            refresh_token: None,
            account_id: None,
            default_model: None,
            auth_path: None,
        },
    ] {
        let (proxy, _proxy) = spawn_proxy(credentials).await?;
        for (declarations, marker, choice) in [
            (
                Some(
                    json!([{"type":"function", "name":"mcp__local_browser__observe", "parameters":{"type":"object"}}]),
                ),
                false,
                "required",
            ),
            (Some(json!([])), true, "none"),
            (None, true, "none"),
        ] {
            let mut input = vec![];
            if let Some(tools) = declarations {
                input.push(json!({"type":"additional_tools", "id":"at_stable", "role":"developer", "tools":tools}));
            }
            input.extend([
                json!({"type":"message", "id":"msg_stable", "role":"developer", "content":[{"type":"input_text", "text":"Use only the declared browser observation tool."}], "metadata":{"stable":"preserve"}}),
                json!({"type":"message", "role":"user", "content":[{"type":"input_text", "text":"Fixture request."}]}),
            ]);
            let mut body = json!({"model":"gpt-6-astra", "instructions":"", "input":input,
                "reasoning":{"effort":"max", "context":"all_turns"},
                "include":["reasoning.encrypted_content"], "store":false,
                "tool_choice":choice, "parallel_tool_calls":false, "stream":false});
            let mut request = client
                .post(format!("http://{proxy}/v1/responses"))
                .json(&body);
            if marker {
                request = request.header(LITE_HEADER, "true");
            }
            let response: Value = request.send().await?.error_for_status()?.json().await?;
            let (headers, forwarded) =
                tokio::time::timeout(Duration::from_secs(5), requests.recv())
                    .await?
                    .expect("fixture upstream receives request");
            assert_eq!(headers[LITE_HEADER], "true");
            assert_eq!(forwarded["input"], body["input"]);
            assert_eq!(forwarded["instructions"], "");
            assert!(
                forwarded.get("tools").is_none(),
                "Lite must not gain legacy tools: {forwarded}"
            );
            assert_eq!(forwarded["tool_choice"], choice);
            assert_eq!(forwarded["parallel_tool_calls"], false);
            assert_eq!(forwarded["reasoning"]["effort"], "max");
            assert_eq!(forwarded["reasoning"]["context"], "all_turns");
            assert_eq!(forwarded["include"], body["include"]);
            assert_eq!(forwarded["store"], false);

            let reasoning = response["output"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["type"] == "reasoning")
                .expect("requested encrypted reasoning must reach the runtime")
                .clone();
            assert_eq!(
                reasoning["encrypted_content"],
                "inert-encrypted-reasoning-fixture"
            );
            body["input"].as_array_mut().unwrap().push(reasoning);
            client
                .post(format!("http://{proxy}/v1/responses"))
                .header(LITE_HEADER, "true")
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
            let (_, continued) = tokio::time::timeout(Duration::from_secs(5), requests.recv())
                .await?
                .expect("fixture upstream receives continuation");
            assert_eq!(continued["input"], body["input"]);
            assert_eq!(continued["include"], body["include"]);
            assert_eq!(continued["store"], false);
        }
        for invalid_controls in [
            json!({"include":"reasoning.encrypted_content"}),
            json!({"include":[false]}),
            json!({"store":"false"}),
        ] {
            let mut body = json!({"model":"gpt-6-astra", "input":[{"type":"message", "role":"user", "content":[]} ]});
            body.as_object_mut()
                .unwrap()
                .extend(invalid_controls.as_object().unwrap().clone());
            let response = client
                .post(format!("http://{proxy}/v1/responses"))
                .header(LITE_HEADER, "true")
                .json(&body)
                .send()
                .await?;
            assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
            assert!(matches!(
                requests.try_recv(),
                Err(mpsc::error::TryRecvError::Empty)
            ));
        }
    }
    let (proxy, _proxy) = spawn_proxy(Credentials::ApiKey {
        key: "fixture-api-key".into(),
        endpoint: Some(format!("http://{upstream}/v1/chat/completions")),
        default_model: None,
    })
    .await?;
    let response = client
        .post(format!("http://{proxy}/v1/responses"))
        .header(LITE_HEADER, "true")
        .json(&json!({"model":"gpt-6-astra", "input":[{"type":"additional_tools", "role":"developer", "tools":[]}]}))
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::BAD_GATEWAY);
    assert!(
        response
            .text()
            .await?
            .contains("Responses Lite requires a Responses upstream")
    );
    assert!(matches!(
        requests.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    Ok(())
}
