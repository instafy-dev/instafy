use std::ffi::OsString;
use std::net::IpAddr;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use reqwest::{Client, Method, Url};
use serde_json::Value as JsonValue;
use uuid::Uuid;

pub const CONTROL_URL_ENV: &str = "INSTAFY_PERSONAL_BROWSER_CONTROL_URL";
pub const CONTROL_TOKEN_ENV: &str = "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN";
pub const PROJECT_ID_ENV: &str = "INSTAFY_PERSONAL_BROWSER_PROJECT_ID";
pub const RUNTIME_AGENT_BIN_ENV: &str = "INSTAFY_RUNTIME_AGENT_BIN";

const PROJECT_HEADER: &str = "x-instafy-project-id";
const CAPABILITY_REQUIRED_MESSAGE: &str = "Personal Browser job requires a complete project-matched desktop capability; refusing Playwright or Shared Browser fallback";
const PERSONAL_RUNTIME_REQUIRES_PERSONAL_JOB_MESSAGE: &str =
    "Personal Browser runtime refuses jobs that are not explicitly desktop-personal";

#[derive(Clone)]
pub struct PersonalBrowserConfig {
    control_url: Url,
    token: String,
    project_id: Uuid,
}

#[derive(Clone)]
struct PersonalBrowserProcessCapability {
    config: PersonalBrowserConfig,
    runtime_agent_bin: PathBuf,
}

static PROCESS_CAPABILITY: OnceLock<Option<PersonalBrowserProcessCapability>> = OnceLock::new();

impl PersonalBrowserConfig {
    pub fn from_env() -> Result<Self> {
        Self::from_env_reader(|key| std::env::var(key).ok())
    }

    fn from_env_reader(mut read: impl FnMut(&str) -> Option<String>) -> Result<Self> {
        let control_url = read(CONTROL_URL_ENV).unwrap_or_default();
        let token = read(CONTROL_TOKEN_ENV).unwrap_or_default();
        let project_id = read(PROJECT_ID_ENV).unwrap_or_default();
        Self::from_values(&control_url, &token, &project_id)
    }

    fn from_values(control_url: &str, token: &str, project_id: &str) -> Result<Self> {
        let control_url = validate_control_url(control_url)?;
        let token = token.trim().to_string();
        if token.is_empty() {
            bail!("Personal Browser capability is unavailable");
        }
        let project_id = Uuid::parse_str(project_id.trim())
            .context("INSTAFY_PERSONAL_BROWSER_PROJECT_ID must be a valid UUID")?;
        Ok(Self {
            control_url,
            token,
            project_id,
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.control_url
            .join(path.trim_start_matches('/'))
            .context("failed to build Personal Browser endpoint")
    }

    fn mcp_endpoint(&self) -> Result<Url> {
        self.endpoint("/mcp")
    }
}

/// Capture the desktop capability before the runtime starts worker threads, then remove its
/// bearer and endpoint identity from the process environment. Untrusted workspace commands and
/// child processes can no longer inherit them; the values remain only in this trusted module.
pub fn capture_and_scrub_process_capability() -> Result<()> {
    let has_personal_values = [CONTROL_URL_ENV, CONTROL_TOKEN_ENV, PROJECT_ID_ENV]
        .iter()
        .any(|key| std::env::var_os(key).is_some());
    let capability = if has_personal_values {
        let config = PersonalBrowserConfig::from_env()?;
        let runtime_agent_bin = std::env::var(RUNTIME_AGENT_BIN_ENV)
            .map(PathBuf::from)
            .context("Personal Browser runtime binary path is unavailable")?;
        if !runtime_agent_bin.is_absolute() || !runtime_agent_bin.is_file() {
            bail!("Personal Browser runtime binary path is invalid");
        }
        Some(PersonalBrowserProcessCapability {
            config,
            runtime_agent_bin,
        })
    } else {
        None
    };
    PROCESS_CAPABILITY
        .set(capability)
        .map_err(|_| anyhow!("Personal Browser process capability was initialized twice"))?;

    // SAFETY: main calls this before constructing either Tokio runtime and before spawning any
    // runtime-agent worker threads. No other thread can concurrently inspect libc's environment.
    unsafe {
        std::env::remove_var(CONTROL_URL_ENV);
        std::env::remove_var(CONTROL_TOKEN_ENV);
        std::env::remove_var(PROJECT_ID_ENV);
    }
    Ok(())
}

fn process_capability() -> Result<PersonalBrowserProcessCapability> {
    if let Some(capability) = PROCESS_CAPABILITY.get() {
        return capability
            .clone()
            .context("Personal Browser capability is unavailable");
    }
    let config = PersonalBrowserConfig::from_env()?;
    let runtime_agent_bin = std::env::var(RUNTIME_AGENT_BIN_ENV)
        .map(PathBuf::from)
        .context("Personal Browser runtime binary path is unavailable")?;
    if !runtime_agent_bin.is_absolute() || !runtime_agent_bin.is_file() {
        bail!("Personal Browser runtime binary path is invalid");
    }
    Ok(PersonalBrowserProcessCapability {
        config,
        runtime_agent_bin,
    })
}

pub fn process_capability_is_present() -> bool {
    process_capability().is_ok()
}

/// Return the trusted in-memory values needed to register the exact Personal Browser MCP server.
/// The token is inserted only into the ephemeral in-memory transport config, never an environment
/// variable inherited by shell tools or child processes.
pub fn mcp_registration_from_process() -> Result<(String, String, String)> {
    let capability = process_capability()?;
    Ok((
        capability.config.mcp_endpoint()?.to_string(),
        capability.config.project_id.to_string(),
        capability.config.token,
    ))
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersonalBrowserRequest {
    method: Method,
    path: String,
    body: Option<JsonValue>,
}

pub fn is_personal_browser_command(args: &[OsString]) -> bool {
    args.first()
        .is_some_and(|value| value == "personal-browser")
}

pub async fn run_cli(args: impl IntoIterator<Item = OsString>) -> Result<()> {
    let args = args
        .into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow!("Personal Browser arguments must be valid UTF-8"))
        })
        .collect::<Result<Vec<_>>>()?;
    if args.as_slice() == ["capabilities"] {
        let payload = crate::codex::personal_browser_capability_contract()?;
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    let request = parse_request_args(&args)?;
    let config = PersonalBrowserConfig::from_env()?;
    let payload = execute_request(&config, &request).await?;
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}

fn parse_request_args(args: &[String]) -> Result<PersonalBrowserRequest> {
    if args.first().map(String::as_str) != Some("request") {
        bail!("usage: runtime-agent personal-browser request <GET|POST> </v1/path> [JSON body]");
    }
    if !(3..=4).contains(&args.len()) {
        bail!("usage: runtime-agent personal-browser request <GET|POST> </v1/path> [JSON body]");
    }

    let method = match args[1].trim().to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => bail!("Personal Browser only supports GET and POST"),
    };
    let path = normalize_allowed_path(&method, &args[2])?;
    let body = args.get(3).map(|raw| {
        serde_json::from_str::<JsonValue>(raw)
            .context("Personal Browser request body must be valid JSON")
    });
    let body = body.transpose()?;

    if method == Method::GET && body.is_some() {
        bail!("Personal Browser GET requests do not accept a body");
    }
    if method == Method::POST && body.is_none() {
        bail!("Personal Browser POST requests require a JSON body");
    }
    if body.as_ref().is_some_and(|value| !value.is_object()) {
        bail!("Personal Browser request body must be a JSON object");
    }

    Ok(PersonalBrowserRequest { method, path, body })
}

fn normalize_allowed_path(method: &Method, raw: &str) -> Result<String> {
    let path = raw.trim();
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['?', '#']) {
        bail!("Personal Browser request path must be an exact /v1 endpoint");
    }
    let allowed = matches!(
        (method, path),
        (&Method::GET, "/v1/status" | "/v1/snapshot")
            | (
                &Method::POST,
                "/v1/navigate" | "/v1/click" | "/v1/type" | "/v1/press" | "/v1/scroll"
            )
    );
    if !allowed {
        bail!("unsupported Personal Browser method/path combination");
    }
    Ok(path.to_string())
}

fn validate_control_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw.trim())
        .context("INSTAFY_PERSONAL_BROWSER_CONTROL_URL must be a valid URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !is_loopback_host(&url)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "INSTAFY_PERSONAL_BROWSER_CONTROL_URL must be an HTTP(S) loopback URL without credentials, query, or fragment"
        );
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host_str() {
        Some(host) if host.eq_ignore_ascii_case("localhost") => true,
        Some(host) => host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false),
        None => false,
    }
}

pub fn payload_requests_personal_browser(payload: &JsonValue) -> bool {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| {
            metadata
                .get("browserTransport")
                .or_else(|| metadata.get("browser_transport"))
        })
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"))
        .as_deref()
        == Some("desktop-personal")
}

pub fn validate_personal_browser_job_capability(
    payload: &JsonValue,
    job_project_id: Option<Uuid>,
) -> Result<()> {
    if let Some(capability) = PROCESS_CAPABILITY.get() {
        return validate_personal_browser_job_capability_with_reader(
            payload,
            job_project_id,
            |key| match (key, capability.as_ref()) {
                (CONTROL_URL_ENV, Some(capability)) => {
                    Some(capability.config.control_url.to_string())
                }
                (CONTROL_TOKEN_ENV, Some(capability)) => Some(capability.config.token.clone()),
                (PROJECT_ID_ENV, Some(capability)) => {
                    Some(capability.config.project_id.to_string())
                }
                (RUNTIME_AGENT_BIN_ENV, Some(capability)) => {
                    Some(capability.runtime_agent_bin.to_string_lossy().into_owned())
                }
                _ => None,
            },
        );
    }
    validate_personal_browser_job_capability_with_reader(payload, job_project_id, |key| {
        std::env::var(key).ok()
    })
}

fn validate_personal_browser_job_capability_with_reader(
    payload: &JsonValue,
    job_project_id: Option<Uuid>,
    mut read: impl FnMut(&str) -> Option<String>,
) -> Result<()> {
    let capability = PersonalBrowserConfig::from_env_reader(|key| read(key)).ok();
    let runtime_agent_bin = read(RUNTIME_AGENT_BIN_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let has_complete_capability = capability.is_some()
        && runtime_agent_bin
            .as_deref()
            .map(Path::new)
            .is_some_and(|path| path.is_absolute() && path.is_file());

    if !payload_requests_personal_browser(payload) {
        if has_complete_capability {
            bail!(PERSONAL_RUNTIME_REQUIRES_PERSONAL_JOB_MESSAGE);
        }
        return Ok(());
    }

    let complete_and_project_matched = capability
        .as_ref()
        .zip(job_project_id.as_ref())
        .is_some_and(|(capability, project_id)| capability.project_id == *project_id)
        && has_complete_capability;

    if !complete_and_project_matched {
        bail!(CAPABILITY_REQUIRED_MESSAGE);
    }
    Ok(())
}

fn build_personal_browser_client(builder: reqwest::ClientBuilder) -> Result<Client> {
    builder
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        // The broker is a device-local capability. Never let HTTP(S)_PROXY or
        // a system proxy receive its bearer token or project identity header.
        .no_proxy()
        .build()
        .context("failed to initialize the Personal Browser client")
}

async fn execute_request(
    config: &PersonalBrowserConfig,
    request: &PersonalBrowserRequest,
) -> Result<JsonValue> {
    let client = build_personal_browser_client(Client::builder())?;
    execute_request_with_client(&client, config, request).await
}

async fn execute_request_with_client(
    client: &Client,
    config: &PersonalBrowserConfig,
    request: &PersonalBrowserRequest,
) -> Result<JsonValue> {
    let endpoint = config.endpoint(&request.path)?;
    let mut builder = client
        .request(request.method.clone(), endpoint)
        .bearer_auth(&config.token)
        .header(PROJECT_HEADER, config.project_id.to_string())
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(body) = request.body.as_ref() {
        builder = builder.json(body);
    }

    let response = builder
        .send()
        .await
        .context("failed to reach the Personal Browser broker")?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .context("failed to read the Personal Browser response")?;
    let mut payload = serde_json::from_str::<JsonValue>(&raw)
        .context("Personal Browser broker returned invalid JSON")?;
    redact_secret_from_json(&mut payload, &config.token);

    if !status.is_success() || payload.get("ok").and_then(JsonValue::as_bool) == Some(false) {
        let message = payload
            .pointer("/error/message")
            .and_then(JsonValue::as_str)
            .unwrap_or("request failed");
        bail!("Personal Browser RPC failed ({status}): {message}");
    }
    Ok(payload)
}

fn redact_secret_from_json(value: &mut JsonValue, secret: &str) {
    if secret.is_empty() {
        return;
    }
    match value {
        JsonValue::String(text) => {
            if text.contains(secret) {
                *text = text.replace(secret, "[REDACTED]");
            }
        }
        JsonValue::Array(values) => {
            for value in values {
                redact_secret_from_json(value, secret);
            }
        }
        JsonValue::Object(map) => {
            let entries = std::mem::take(map);
            for (key, mut value) in entries {
                redact_secret_from_json(&mut value, secret);
                map.insert(key.replace(secret, "[REDACTED]"), value);
            }
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::Json;
    use axum::Router;
    use axum::http::HeaderMap;
    use axum::routing::{get, post};
    use serde_json::json;

    use super::*;

    const PROJECT_ID: &str = "11111111-1111-4111-8111-111111111111";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn reads_complete_capability_from_environment_values() {
        let values = HashMap::from([
            (CONTROL_URL_ENV, "http://127.0.0.1:43127".to_string()),
            (CONTROL_TOKEN_ENV, "short-lived-secret".to_string()),
            (PROJECT_ID_ENV, PROJECT_ID.to_string()),
        ]);
        let config = PersonalBrowserConfig::from_env_reader(|key| values.get(key).cloned())
            .expect("valid capability");

        assert_eq!(
            config.endpoint("/v1/status").expect("status URL").as_str(),
            "http://127.0.0.1:43127/v1/status"
        );
        assert_eq!(config.project_id.to_string(), PROJECT_ID);
    }

    #[test]
    fn rejects_remote_or_incomplete_capabilities_without_echoing_token() {
        let secret = "must-not-appear";
        let remote =
            PersonalBrowserConfig::from_values("https://browser.example.com", secret, PROJECT_ID)
                .err()
                .expect("remote URL rejected")
                .to_string();
        assert!(!remote.contains(secret));

        let missing_project =
            PersonalBrowserConfig::from_values("http://localhost:43127", secret, "")
                .err()
                .expect("missing project rejected")
                .to_string();
        assert!(!missing_project.contains(secret));
    }

    #[test]
    fn parses_each_supported_high_level_request() {
        for (method, path, body) in [
            ("GET", "/v1/status", None),
            ("GET", "/v1/snapshot", None),
            (
                "POST",
                "/v1/navigate",
                Some(r#"{"url":"https://example.com"}"#),
            ),
            ("POST", "/v1/click", Some(r#"{"index":3}"#)),
            ("POST", "/v1/type", Some(r#"{"index":2,"text":"hello"}"#)),
            ("POST", "/v1/press", Some(r#"{"key":"Escape"}"#)),
            ("POST", "/v1/scroll", Some(r#"{"x":0,"y":720}"#)),
        ] {
            let mut args = vec!["request", method, path];
            if let Some(body) = body {
                args.push(body);
            }
            let parsed = parse_request_args(&strings(&args)).expect("supported request");
            assert_eq!(parsed.path, path);
        }
    }

    #[test]
    fn rejects_arbitrary_paths_methods_and_malformed_bodies() {
        assert!(parse_request_args(&strings(&["request", "DELETE", "/v1/status"])).is_err());
        assert!(parse_request_args(&strings(&["request", "GET", "https://example.com"])).is_err());
        assert!(
            parse_request_args(&strings(&["request", "POST", "/v1/navigate", "nope"])).is_err()
        );
        assert!(parse_request_args(&strings(&["request", "POST", "/v1/unknown", "{}"])).is_err());
    }

    #[test]
    fn personal_browser_jobs_fail_closed_without_a_complete_matching_capability() {
        let personal_payload = json!({
            "metadata": {
                "browserTransport": "desktop-personal"
            }
        });
        let project_id = Uuid::parse_str(PROJECT_ID).expect("project UUID");

        let missing = validate_personal_browser_job_capability_with_reader(
            &personal_payload,
            Some(project_id),
            |_| None,
        )
        .expect_err("missing capability must be rejected")
        .to_string();
        assert!(missing.contains("refusing Playwright or Shared Browser fallback"));

        let runtime_agent_bin = std::env::current_exe().expect("test binary path");
        let values = HashMap::from([
            (CONTROL_URL_ENV, "http://127.0.0.1:43127".to_string()),
            (CONTROL_TOKEN_ENV, "short-lived-secret".to_string()),
            (PROJECT_ID_ENV, PROJECT_ID.to_string()),
            (
                RUNTIME_AGENT_BIN_ENV,
                runtime_agent_bin.to_string_lossy().into_owned(),
            ),
        ]);
        validate_personal_browser_job_capability_with_reader(
            &personal_payload,
            Some(project_id),
            |key| values.get(key).cloned(),
        )
        .expect("complete matching capability");

        let other_project_id =
            Uuid::parse_str("22222222-2222-4222-8222-222222222222").expect("other project UUID");
        assert!(
            validate_personal_browser_job_capability_with_reader(
                &personal_payload,
                Some(other_project_id),
                |key| values.get(key).cloned(),
            )
            .is_err()
        );
    }

    #[test]
    fn ordinary_jobs_do_not_require_a_personal_browser_capability() {
        validate_personal_browser_job_capability_with_reader(
            &json!({ "metadata": { "browserTransport": "shared" } }),
            None,
            |_| None,
        )
        .expect("ordinary jobs stay portable");
        assert!(payload_requests_personal_browser(&json!({
            "metadata": { "browser_transport": "desktop_personal" }
        })));

        let runtime_agent_bin = std::env::current_exe().expect("test binary path");
        let values = HashMap::from([
            (CONTROL_URL_ENV, "http://127.0.0.1:43127".to_string()),
            (CONTROL_TOKEN_ENV, "short-lived-secret".to_string()),
            (PROJECT_ID_ENV, PROJECT_ID.to_string()),
            (
                RUNTIME_AGENT_BIN_ENV,
                runtime_agent_bin.to_string_lossy().into_owned(),
            ),
        ]);
        let error = validate_personal_browser_job_capability_with_reader(
            &json!({ "metadata": { "browserTransport": "shared" } }),
            Some(Uuid::parse_str(PROJECT_ID).expect("project UUID")),
            |key| values.get(key).cloned(),
        )
        .expect_err("Personal Browser runtimes must reject ordinary jobs")
        .to_string();
        assert!(error.contains("not explicitly desktop-personal"));
    }

    #[test]
    fn recognizes_only_the_explicit_personal_browser_namespace() {
        assert!(is_personal_browser_command(&[OsString::from(
            "personal-browser"
        )]));
        assert!(!is_personal_browser_command(&[OsString::from(
            "apply_patch"
        )]));
        assert!(!is_personal_browser_command(&[]));
    }

    #[tokio::test]
    async fn capabilities_command_requires_no_personal_browser_secret() {
        run_cli([OsString::from("capabilities")])
            .await
            .expect("capability contract is a secret-free packaged-binary probe");
    }

    #[test]
    fn redacts_the_capability_from_any_broker_json_before_output() {
        let secret = "must-never-be-logged";
        let mut payload = json!({
            "ok": true,
            "nested": [
                { "message": format!("unexpected {secret} value") },
                secret,
            ],
        });

        redact_secret_from_json(&mut payload, secret);

        let rendered = serde_json::to_string(&payload).expect("render redacted payload");
        assert!(!rendered.contains(secret));
        assert!(rendered.contains("[REDACTED]"));
    }

    #[tokio::test]
    async fn sends_bearer_and_project_headers_to_the_loopback_broker() {
        async fn navigate(headers: HeaderMap, Json(body): Json<JsonValue>) -> Json<JsonValue> {
            assert_eq!(
                headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok()),
                Some("Bearer test-capability")
            );
            assert_eq!(
                headers
                    .get(PROJECT_HEADER)
                    .and_then(|value| value.to_str().ok()),
                Some(PROJECT_ID)
            );
            assert_eq!(body["url"], "https://example.com");
            Json(json!({ "ok": true, "status": { "url": body["url"] } }))
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test broker");
        let address = listener.local_addr().expect("test broker address");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/v1/navigate", post(navigate)),
            )
            .await
            .expect("serve test broker");
        });

        let config = PersonalBrowserConfig::from_values(
            &format!("http://{address}"),
            "test-capability",
            PROJECT_ID,
        )
        .expect("test capability");
        let request = parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/navigate",
            r#"{"url":"https://example.com"}"#,
        ]))
        .expect("navigate request");

        let response = execute_request(&config, &request)
            .await
            .expect("broker response");
        assert_eq!(response["ok"], true);
        server.abort();
    }

    #[tokio::test]
    async fn loopback_client_clears_even_an_explicit_poison_proxy() {
        async fn status() -> Json<JsonValue> {
            Json(json!({ "ok": true, "status": { "state": "ready" } }))
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test broker");
        let address = listener.local_addr().expect("test broker address");
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/v1/status", get(status)))
                .await
                .expect("serve test broker");
        });

        let config = PersonalBrowserConfig::from_values(
            &format!("http://{address}"),
            "test-capability",
            PROJECT_ID,
        )
        .expect("test capability");
        let request = parse_request_args(&strings(&["request", "GET", "/v1/status"]))
            .expect("status request");
        let poison_proxy = reqwest::Proxy::all("http://127.0.0.1:9").expect("poison proxy");
        let client = build_personal_browser_client(Client::builder().proxy(poison_proxy))
            .expect("loopback client");

        let response = execute_request_with_client(&client, &config, &request)
            .await
            .expect("request bypasses poison proxy");
        assert_eq!(response["status"]["state"], "ready");
        server.abort();
    }
}
