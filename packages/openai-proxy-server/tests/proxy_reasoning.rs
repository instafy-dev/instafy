//! This separate integration-test process isolates the cached global effort.
//! All credentials are fixtures and every upstream is a loopback HTTP server.
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Result;
use axum::extract::{OriginalUri, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use openai_proxy_server::auth::Credentials;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

struct TaskGuard(tokio::task::JoinHandle<()>);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct EnvGuard(&'static str, Option<std::ffi::OsString>);

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let original = std::env::var_os(key);
        // One test, with the default current-thread Tokio runtime, owns these fixtures.
        unsafe { std::env::set_var(key, value) };
        Self(key, original)
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.1 {
                Some(value) => std::env::set_var(self.0, value),
                None => std::env::remove_var(self.0),
            }
        }
    }
}

async fn capture_upstream(
    State(captured): State<mpsc::UnboundedSender<Value>>,
    OriginalUri(uri): OriginalUri,
    Json(payload): Json<Value>,
) -> Response {
    captured.send(payload.clone()).unwrap();
    if uri.path() == "/v1/chat/completions" {
        return Json(json!({
            "id": "chatcmpl-test", "model": payload["model"],
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]
        })).into_response();
    }
    let response = json!({
        "id": "resp_test", "object": "response", "model": payload["model"], "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}]
    });
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
fn requested_and_global_reasoning_survive_serialized_upstream_requests() -> Result<()> {
    const CHILD_GLOBAL: &str = "PROXY_REASONING_TEST_GLOBAL";
    if let Ok(global) = std::env::var(CHILD_GLOBAL) {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(assert_reasoning_requests(&global));
    }
    // Each cached global configuration gets a fresh, credential-free process.
    // In particular, a high fallback cannot mask a dropped explicit max request.
    for global in ["high", " XHIGH ", " MAX ", "lots", ""] {
        let output = std::process::Command::new(std::env::current_exe()?)
            .env_clear()
            .env(CHILD_GLOBAL, global)
            .args([
                "--exact",
                "requested_and_global_reasoning_survive_serialized_upstream_requests",
            ])
            .output()?;
        assert!(
            output.status.success(),
            "global={global:?}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

async fn assert_reasoning_requests(global: &str) -> Result<()> {
    let global_expected = match global {
        "high" => Some("high"),
        " XHIGH " => Some("xhigh"),
        " MAX " => Some("max"),
        "lots" | "" => None,
        _ => anyhow::bail!("unknown fixture global"),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream = listener.local_addr()?;
    let _env = [
        EnvGuard::set("CODEX_REASONING_EFFORT", global),
        EnvGuard::set(
            "CODEX_PROXY_CHATGPT_ENDPOINT",
            &format!("http://{upstream}/backend-api/codex/responses"),
        ),
        EnvGuard::set("PROXY_CONTROLLER_BASE_URL", ""),
        EnvGuard::set("CONTROLLER_BASE_URL", ""),
        EnvGuard::set("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        EnvGuard::set("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
    ];
    let (captured_tx, mut captured_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(capture_upstream))
        .route("/v1/chat/completions", post(capture_upstream))
        .route("/backend-api/codex/responses", post(capture_upstream))
        .with_state(captured_tx);
    let _upstream_task = TaskGuard(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let credentials = [
        (
            Credentials::ChatGpt {
                access_token: "fixture-access-token".into(),
                refresh_token: None,
                account_id: None,
                default_model: None,
                auth_path: None,
            },
            "/reasoning/effort",
        ),
        (
            Credentials::ApiKey {
                key: "fixture-api-key".into(),
                endpoint: Some(format!("http://{upstream}/v1/responses")),
                default_model: None,
            },
            "/reasoning/effort",
        ),
        (
            Credentials::ApiKey {
                key: "fixture-api-key".into(),
                endpoint: Some(format!("http://{upstream}/v1/chat/completions")),
                default_model: None,
            },
            "/reasoning_effort",
        ),
    ];

    for (credentials, upstream_field) in credentials {
        let fallback = global_expected.or(if credentials.is_chatgpt() {
            Some("medium")
        } else {
            None
        });
        let (addr, _proxy_task) = spawn_proxy(credentials).await?;
        for route in ["responses", "chat/completions"] {
            // Valid values override the global; xhigh/max must not be dropped.
            // Absent, invalid and wrongly typed requests still use the global fallback.
            for (requested, expected) in [
                (Some(json!("minimal")), Some("minimal")),
                (Some(json!("low")), Some("low")),
                (Some(json!("medium")), Some("medium")),
                (Some(json!("high")), Some("high")),
                (Some(json!("xhigh")), Some("xhigh")),
                (Some(json!("max")), Some("max")),
                (Some(json!(" XHIGH ")), Some("xhigh")),
                (Some(json!(" MAX ")), Some("max")),
                (None, fallback),
                (Some(json!("lots")), fallback),
                (Some(json!("")), fallback),
                (Some(json!(true)), fallback),
            ] {
                let mut request =
                    json!({"model": "gpt-6-astra", "stream": false, "tool_choice": "none"});
                if route == "responses" {
                    request["input"] = json!("Reply ok.");
                    if let Some(effort) = requested {
                        request["reasoning"] = json!({"effort": effort});
                    }
                } else {
                    request["messages"] = json!([{"role": "user", "content": "Reply ok."}]);
                    if let Some(effort) = requested {
                        request["reasoning_effort"] = effort;
                    }
                }
                let response = client
                    .post(format!("http://{addr}/v1/{route}"))
                    .json(&request)
                    .send()
                    .await?;
                assert!(
                    response.status().is_success(),
                    "{route}: {}",
                    response.text().await?
                );
                let payload = tokio::time::timeout(Duration::from_secs(1), captured_rx.recv())
                    .await?
                    .unwrap();
                assert_eq!(payload["model"], "gpt-6-astra");
                assert_eq!(
                    payload.pointer(upstream_field).and_then(Value::as_str),
                    expected,
                    "{route} lost effort in {payload}"
                );
            }
        }
    }
    Ok(())
}
