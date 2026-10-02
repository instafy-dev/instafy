//! Opt-in real-model review probe. The fixture owner supplies a migrated,
//! disposable loopback controller and active job; this test never seeds or
//! changes a hosted database. See docs/Space-Review.md for its input contract.

use anyhow::{Context, Result, ensure};
use openai_proxy_server::{auth, proxy};
use runtime_agent::config::Config;
use runtime_agent::controller::{LeaseJob, Registration};
use runtime_agent::jobs::{JobProcessor, extract_job_failure_artifacts};
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    controller_url: String,
    runtime_id: Uuid,
    job: LeaseJob,
    #[serde(default)]
    minimum_new: usize,
    #[serde(default = "maximum_new")]
    maximum_new: usize,
}

fn maximum_new() -> usize {
    3
}

struct Environment(Vec<(String, Option<std::ffi::OsString>)>);

impl Environment {
    fn set(&mut self, key: &str, value: impl AsRef<std::ffi::OsStr>) {
        self.0.push((key.to_owned(), std::env::var_os(key)));
        unsafe { std::env::set_var(key, value) };
    }

    fn remove(&mut self, key: &str) {
        self.0.push((key.to_owned(), std::env::var_os(key)));
        unsafe { std::env::remove_var(key) };
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        for (key, previous) in self.0.iter().rev() {
            if let Some(value) = previous {
                unsafe { std::env::set_var(key, value) };
            } else {
                unsafe { std::env::remove_var(key) };
            }
        }
    }
}

struct ProxyShutdown(Option<oneshot::Sender<()>>);

impl Drop for ProxyShutdown {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

fn redact(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => {
            for secret in secrets.iter().filter(|value| !value.is_empty()) {
                *text = text.replace(secret, "[redacted]");
            }
        }
        Value::Array(values) => values.iter_mut().for_each(|value| redact(value, secrets)),
        Value::Object(values) => values.values_mut().for_each(|value| redact(value, secrets)),
        _ => {}
    }
}

async fn recommendations(fixture: &Fixture) -> Result<Vec<Value>> {
    let response = reqwest::Client::new()
        .get(format!(
            "{}/projects/{}/recommendations?limit=200",
            fixture.controller_url.trim_end_matches('/'),
            fixture
                .job
                .project_id
                .context("fixture job needs project_id")?
        ))
        .bearer_auth(
            fixture
                .job
                .controller_token
                .as_ref()
                .context("fixture job needs controller_token")?,
        )
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "fixture recommendations returned {}",
        response.status()
    );
    let body: Value = response.json().await?;
    Ok(body["recommendations"]
        .as_array()
        .context("missing recommendations array")?
        .clone())
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn has_model_turn(artifacts: &[Value]) -> bool {
    artifacts.iter().any(|artifact| {
        artifact["kind"] == "codex/run-log"
            && artifact["events"].as_array().is_some_and(|events| {
                events.iter().any(|event| {
                    event["type"] == "turn.completed"
                        && event["usage"]["total_tokens"]
                            .as_u64()
                            .is_some_and(|count| count > 0)
                })
            })
    })
}

fn workspace_inventory(root: &Path, directory: &Path, entries: &mut Vec<Value>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        ensure!(
            entries.len() < 2_000,
            "workspace inventory exceeded fixture budget"
        );
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            workspace_inventory(root, &path, entries)?;
        } else {
            entries.push(json!({"path":path.strip_prefix(root)?.to_string_lossy(), "bytes":entry.metadata()?.len(), "symlink":kind.is_symlink()}));
        }
    }
    Ok(())
}

#[test]
#[ignore = "real model: requires disposable loopback controller, active scoped job, and proxy credentials"]
fn space_review_live_scoped_job() -> Result<()> {
    // JobProcessor embeds a large Codex future. Match the existing proxy
    // integration harness's explicit stack budget instead of libtest's 2 MiB.
    std::thread::Builder::new()
        .name("space-review-live".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()?
                .block_on(run_space_review_live())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("live review worker panicked"))?
}

async fn run_space_review_live() -> Result<()> {
    ensure!(
        std::env::var("RUN_LIVE_SPACE_REVIEW").as_deref() == Ok("1"),
        "set RUN_LIVE_SPACE_REVIEW=1 explicitly"
    );
    let manifest = PathBuf::from(std::env::var("SPACE_REVIEW_LIVE_FIXTURE")?);
    let report_path = PathBuf::from(std::env::var("SPACE_REVIEW_LIVE_REPORT")?);
    ensure!(
        manifest.is_absolute() && report_path.is_absolute(),
        "fixture and report paths must be absolute"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            fs::metadata(&manifest)?.permissions().mode() & 0o077 == 0,
            "fixture manifest must be private (0600)"
        );
    }
    let fixture: Fixture = serde_json::from_slice(&fs::read(&manifest)?)?;
    let controller = reqwest::Url::parse(&fixture.controller_url)?;
    ensure!(
        controller.scheme() == "http"
            && controller.host_str() == Some("127.0.0.1")
            && controller.username().is_empty()
            && controller.password().is_none(),
        "live review fixture must use literal loopback HTTP"
    );
    ensure!(
        fixture.maximum_new <= 3 && fixture.minimum_new <= fixture.maximum_new,
        "invalid fixture recommendation bounds"
    );
    ensure!(
        fixture.job.conversation_id.is_some() && fixture.job.run_id.is_some(),
        "fixture job needs conversation and run"
    );
    ensure!(
        fixture.job.proxy.is_none(),
        "proxy is owned by this test, not the fixture"
    );
    let prompt = fixture
        .job
        .payload
        .get("prompt_text")
        .and_then(Value::as_str)
        .context("fixture prompt_text missing")?;
    ensure!(
        prompt.contains("instafy-space-review"),
        "fixture must explicitly invoke the review skill"
    );
    let model = std::env::var("SPACE_REVIEW_LIVE_MODEL").unwrap_or_else(|_| "gpt-5.5".to_owned());
    let auth_path = std::env::var_os("SPACE_REVIEW_LIVE_PROXY_AUTH_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".codex/auth.json")
        });
    let node = PathBuf::from(std::env::var("SPACE_REVIEW_LIVE_NODE")?);
    ensure!(
        node.is_absolute() && node.is_file(),
        "SPACE_REVIEW_LIVE_NODE must be an absolute Node executable"
    );
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let cli = repository.join("packages/instafy-cli/bin/instafy.js");
    ensure!(
        repository
            .join("packages/instafy-cli/dist/cli.js")
            .is_file(),
        "build the exact checkout CLI first"
    );

    // Load upstream credentials only into proxy-owned state. The temporary
    // source copy is removed before model execution and never enters its home.
    let mut source_auth: Value = serde_json::from_slice(&fs::read(auth_path)?)?;
    source_auth
        .as_object_mut()
        .context("invalid proxy auth")?
        .remove("OPENAI_API_KEY");
    // An expiring token should fail this probe instead of rotating the host's
    // interactive login behind its back. The proxy needs only access + account.
    if let Some(tokens) = source_auth.get_mut("tokens").and_then(Value::as_object_mut) {
        tokens.remove("refresh_token");
        tokens.remove("id_token");
    }
    let mut secrets = vec![
        fixture
            .job
            .controller_token
            .clone()
            .context("fixture job needs controller_token")?,
    ];
    if let Some(tokens) = source_auth.get("tokens").and_then(Value::as_object) {
        secrets.extend(tokens.values().filter_map(Value::as_str).map(str::to_owned));
    }
    let proxy_home = TempDir::new()?;
    let proxy_auth = proxy_home.path().join("auth.json");
    private_write(&proxy_auth, &serde_json::to_vec(&source_auth)?)?;
    let mut environment = Environment(Vec::new());
    environment.remove("OPENAI_API_KEY");
    let mut credentials = auth::load_credentials(Some(&proxy_auth))?;
    if let auth::Credentials::ChatGpt { auth_path, .. } = &mut credentials {
        *auth_path = None;
    } else {
        anyhow::bail!("this live probe requires ChatGPT proxy credentials");
    }
    drop(source_auth);
    fs::remove_file(proxy_auth)?;
    drop(proxy_home);

    let workspace = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let cli_config = runtime_home.path().join("instafy-config.json");
    private_write(&cli_config, b"{}")?;
    let runtime_auth = runtime_home.path().join("auth.json");
    private_write(
        &runtime_auth,
        br#"{"OPENAI_API_KEY":"live-review-proxy-only"}"#,
    )?;
    let bin = TempDir::new()?;
    let shim = bin.path().join("instafy");
    private_write(
        &shim,
        format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            shell_quote(&node),
            shell_quote(&cli)
        )
        .as_bytes(),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o700))?;
    }
    let socket = std::net::TcpListener::bind("127.0.0.1:0")?;
    let proxy_address = socket.local_addr()?;
    drop(socket);
    let (shutdown, finished) = oneshot::channel();
    let proxy_guard = ProxyShutdown(Some(shutdown));
    environment.set("CODEX_PROXY_CHATGPT_ENDPOINT", "");
    let proxy_task = tokio::spawn(async move {
        proxy::run_proxy_with_shutdown(proxy_address, Some(credentials), async move {
            let _ = finished.await;
        })
        .await
    });
    for attempt in 0..100 {
        if tokio::net::TcpStream::connect(proxy_address).await.is_ok() {
            break;
        }
        ensure!(attempt < 99, "proxy did not listen");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let current_path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![bin.path().to_path_buf()];
    paths.extend(std::env::split_paths(&current_path));
    environment.set("PATH", std::env::join_paths(paths)?);
    environment.set("INSTAFY_CLI_CONFIG", &cli_config);
    environment.set("CODEX_HOME", runtime_home.path());
    environment.set("CODEX_AUTH_PATH", &runtime_auth);
    environment.set("CODEX_MODEL", &model);
    environment.set("CODEX_RUNTIME_REASONING_EFFORT", "medium");
    environment.set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("http://{proxy_address}/backend-api/codex/responses"),
    );
    environment.set("OPENAI_BASE_URL", format!("http://{proxy_address}/v1"));
    environment.set("OPENAI_API_KEY", "live-review-proxy-only");
    environment.set("WORKSPACE_DIR", workspace.path());
    environment.set(
        "SPACE_ID",
        fixture
            .job
            .project_id
            .context("fixture project missing")?
            .to_string(),
    );
    environment.set("RUNTIME_ID", fixture.runtime_id.to_string());
    environment.set("CONTROLLER_BASE_URL", &fixture.controller_url);
    environment.set("RUNTIME_ACCESS_TOKEN", "live-review-unused-registration");
    environment.set("RUNTIME_STRICT_MODE", "0");
    environment.set("RUNTIME_DEV_ISOLATION", "0");
    environment.set("INSTAFY_RUNTIME_FLAVOR", "base");
    for key in [
        "SPACE_REVIEW_LIVE_FIXTURE",
        "SPACE_REVIEW_LIVE_REPORT",
        "SPACE_REVIEW_LIVE_PROXY_AUTH_PATH",
        "SPACE_REVIEW_LIVE_NODE",
        "CONTROLLER_JWKS_URL",
        "WORKSPACE_PROJECT_DIR",
        "WORKSPACE_ROOT",
        "CODEX_API_ENDPOINT",
    ] {
        environment.remove(key);
    }
    let config = Arc::new(Config::from_env()?);
    let registration = Registration {
        runtime_id: fixture.runtime_id,
        agent_token: "live-review-unused-agent".into(),
        runtime_token: None,
        lease_url: controller.join("/lease")?,
        heartbeat_url: controller.join("/heartbeat")?,
        stop_url: None,
        lease_id: None,
        proxy: None,
        lease_scope: None,
        tenant_projects: vec![],
        workspace_manifest: None,
        parent_lease_id: None,
        agent_token_scopes: vec![],
        agent_token_issued_at: None,
        agent_token_expires_at: None,
        agent_token_ttl: None,
    };
    let before = recommendations(&fixture).await?;
    let execution = tokio::time::timeout(
        Duration::from_secs(420),
        JobProcessor::new(config).run_apply_job(
            &registration,
            &fixture.job,
            false,
            None,
            None,
            None,
        ),
    )
    .await;
    let after = recommendations(&fixture).await?;
    let mut report = json!({"model":model,"projectId":fixture.job.project_id,"conversationId":fixture.job.conversation_id,"jobId":fixture.job.id,"before":before,"after":after});
    let successful = match execution {
        Ok(Ok(execution)) => {
            report["liveModelTurnVerified"] = json!(
                execution.provider == "codex-embedded" && has_model_turn(&execution.artifacts)
            );
            report["provider"] = json!(execution.provider);
            report["summary"] = json!(execution.summary);
            report["suggestedReplies"] = json!(execution.suggested_replies);
            report["artifacts"] = json!(execution.artifacts);
            report["messages"] = json!(execution.messages.iter().chain(execution.final_messages.iter()).map(|m| json!({"content":m.content,"messageType":m.message_type,"metadata":m.metadata})).collect::<Vec<_>>());
            true
        }
        Ok(Err(error)) => {
            report["error"] = json!(format!("{error:#}"));
            report["artifacts"] = json!(extract_job_failure_artifacts(&error));
            false
        }
        Err(_) => {
            report["error"] = json!("live review exceeded 420 seconds");
            false
        }
    };
    let mut files = Vec::new();
    workspace_inventory(workspace.path(), workspace.path(), &mut files)?;
    report["workspaceFiles"] = json!(files);
    redact(&mut report, &secrets);
    private_write(&report_path, &serde_json::to_vec_pretty(&report)?)?;
    drop(proxy_guard);
    tokio::time::timeout(Duration::from_secs(30), proxy_task)
        .await
        .context("proxy shutdown timed out")???;
    ensure!(successful, "live review failed; inspect the private report");
    ensure!(
        report["liveModelTurnVerified"] == true,
        "live review did not prove a codex-embedded model turn with positive token usage"
    );
    for previous in before
        .iter()
        .filter(|item| matches!(item["status"].as_str(), Some("accepted" | "dismissed")))
    {
        ensure!(
            after.iter().any(|item| item == previous),
            "an earlier terminal recommendation changed"
        );
    }
    let new_count = after
        .iter()
        .filter(|item| !before.iter().any(|previous| previous["id"] == item["id"]))
        .count();
    ensure!(
        (fixture.minimum_new..=fixture.maximum_new).contains(&new_count),
        "expected {}..={} new recommendations, observed {new_count}; inspect private report",
        fixture.minimum_new,
        fixture.maximum_new
    );
    println!(
        "live review completed through Instafy proxy: model={model}, new_recommendations={new_count}"
    );
    Ok(())
}

#[test]
fn model_turn_evidence_requires_completed_nonzero_usage() {
    assert!(!has_model_turn(&[]));
    assert!(!has_model_turn(&[
        json!({"kind":"codex/run-log","events":[{"type":"turn.completed","usage":{"total_tokens":0}}]})
    ]));
    assert!(!has_model_turn(&[
        json!({"kind":"codex/run-log","events":[{"type":"item.completed","usage":{"total_tokens":12}}]})
    ]));
    assert!(has_model_turn(&[
        json!({"kind":"codex/run-log","events":[{"type":"turn.completed","usage":{"total_tokens":12}}]})
    ]));
}
