use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, State};
use axum::http::{HeaderMap, StatusCode, request::Parts};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream;
use reqwest::Url;
use serde_json::{Map as JsonMap, Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::auth::{Credentials, response_indicates_chatgpt_token_expired};
use crate::client::{
    CodexClient, CodexCompletion, DEFAULT_INSTRUCTIONS, DEFAULT_MODEL, conversation_id_enabled,
    normalize_reasoning_effort,
};
use crate::controller_client::ControllerCreditsError;
use crate::controller_integration::{ControllerIntegration, CreditBurn as ControllerCreditBurn};
use crate::proxy_auth::ProxyClaims;
use crate::upstream_error::{self, UpstreamFailure};

const MAX_PROXY_REQUEST_BYTES: usize = 25 * 1024 * 1024;
const PUBLIC_PROXY_LANE_HEADER: &str = "x-instafy-proxy-lane";
const PUBLIC_PERSONAL_BROWSER_LANE: &str = "public-personal-browser";

/// Fixed credential id a `RemoteDynamic` proxy leases for a managed-lane
/// turn (a controller-signed token with no `credential_id`). The controller
/// answers it from its own `MANAGED_AI_OPENAI_API_KEY` without a user lookup
/// (`runtime-controller::config::MANAGED_AI_CREDENTIAL_ID`); keep the two
/// constants equal.
pub const MANAGED_AI_CREDENTIAL_ID: &str = "4d414e41-4745-4441-8949-4e5354414659";

#[derive(Clone)]
enum ProxyBackend {
    RemoteStatic(Credentials),
    RemoteDynamic,
}

#[derive(Clone)]
struct ProxyState {
    backend: ProxyBackend,
    controller: Option<ControllerIntegration>,
    require_controller_auth: bool,
    require_credential_claim: bool,
}

struct AuthenticatedProxyClaims(Option<ProxyClaims>);

#[async_trait]
impl FromRequestParts<ProxyState> for AuthenticatedProxyClaims {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &ProxyState,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(state.authenticate(&parts.headers)?))
    }
}

enum ProxyCompletion {
    Remote(CodexCompletion),
}

impl ProxyCompletion {
    fn into_response_body(self) -> Value {
        match self {
            Self::Remote(completion) => {
                let mut response_body = completion.raw.clone();
                if response_body.get("conversation").is_none() {
                    if let Some(conv_id) = completion.conversation_id.as_ref() {
                        response_body["conversation"] = json!({ "id": conv_id });
                    }
                }
                response_body
            }
        }
    }
}

// Model contract: an ABSENT (empty) request model resolves to the
// credential's default; an explicit model id is honored verbatim on OpenAI
// endpoints. There is deliberately no magic model id that means "use the
// default" — when DEFAULT_MODEL was that sentinel, an explicit pick of the
// same id was silently rewritten to the credential default (issue #116).
// Cross-provider mismatches (an OpenAI-shaped id sent at a BYOC provider)
// still resolve to the credential default so requests don't 404 upstream.
fn resolve_model_for_credentials(requested_model: &str, credentials: &Credentials) -> String {
    let requested = requested_model.trim();
    let endpoint = credentials.endpoint();
    let default_model = credentials
        .default_model()
        .or_else(|| fallback_default_model_for_endpoint(endpoint));

    if let Some(default_model) = default_model {
        // For known BYOC providers (DeepSeek/z.ai), always use the credential default model.
        // The runtime may send a Codex/OpenAI model id, or even the wrong provider model, and we
        // want the credential itself to be authoritative.
        if known_byoc_provider_for_endpoint(endpoint).is_some() {
            return default_model.to_string();
        }

        if !requested.is_empty()
            && credentials.is_chatgpt()
            && looks_like_non_chatgpt_model_id(requested)
        {
            return default_model.to_string();
        }

        if should_use_default_model_for_request(requested, endpoint) {
            return default_model.to_string();
        }
    }

    if requested.is_empty() {
        // Last resort: a model-less request against a credential that carries
        // no default (local/dev auth.json paths).
        return DEFAULT_MODEL.to_string();
    }
    requested.to_string()
}

fn should_use_default_model_for_request(requested_model: &str, endpoint: &str) -> bool {
    let requested = requested_model.trim();
    if requested.is_empty() {
        return true;
    }

    // For BYOC providers (DeepSeek/z.ai/etc), the UI/runtime may still send OpenAI model ids (e.g. gpt-4.5).
    // Prefer the provider's configured default model so requests don't fail with "Model Not Exist".
    if !endpoint_is_openai(endpoint) && looks_like_openai_model_id(requested) {
        return true;
    }

    false
}

fn endpoint_is_openai(endpoint: &str) -> bool {
    let lowered = endpoint.trim().to_ascii_lowercase();
    lowered.contains("api.openai.com") || lowered.contains("chatgpt.com")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KnownByocProvider {
    DeepSeek,
    Zai,
    Gemini,
}

fn known_byoc_provider_for_endpoint(endpoint: &str) -> Option<KnownByocProvider> {
    let lowered = endpoint.trim().to_ascii_lowercase();
    if lowered.contains("deepseek") {
        return Some(KnownByocProvider::DeepSeek);
    }
    if lowered.contains("api.z.ai") || lowered.contains("//z.ai") || lowered.contains("z.ai/") {
        return Some(KnownByocProvider::Zai);
    }
    if lowered.contains("generativelanguage.googleapis.com")
        || lowered.contains("googleapis.com/v1beta/openai/chat/completions")
        || lowered.contains("cloudcode-pa.googleapis.com")
        || lowered.contains("cloudaicompanion.googleapis.com")
    {
        return Some(KnownByocProvider::Gemini);
    }
    None
}

fn fallback_default_model_for_endpoint(endpoint: &str) -> Option<&'static str> {
    match known_byoc_provider_for_endpoint(endpoint) {
        Some(KnownByocProvider::DeepSeek) => Some("deepseek-chat"),
        Some(KnownByocProvider::Zai) => Some("glm-5"),
        Some(KnownByocProvider::Gemini) => Some("gemini-2.5-pro"),
        None => None,
    }
}

fn format_endpoint_for_error(endpoint: &str) -> String {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?;
            Some(format!("{}{}", host, url.path()))
        })
        .unwrap_or_else(|| endpoint.trim().to_string())
}

fn looks_like_openai_model_id(model: &str) -> bool {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return true;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("codex") {
        return true;
    }
    if lowered.starts_with("gpt-") {
        return true;
    }

    // OpenAI reasoning models like o1 / o3 / o4-mini.
    if lowered.starts_with('o') {
        let mut chars = lowered.chars();
        let _ = chars.next();
        if matches!(chars.next(), Some(ch) if ch.is_ascii_digit()) {
            return true;
        }
    }

    false
}

fn looks_like_non_chatgpt_model_id(model: &str) -> bool {
    let lowered = model.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }

    lowered.starts_with("glm-")
        || lowered.starts_with("deepseek-")
        || lowered.starts_with("gemini-")
}

fn requested_reasoning_effort(payload: &Value) -> Option<String> {
    let effort = payload
        .get("reasoning")
        .and_then(Value::as_object)
        .and_then(|reasoning| reasoning.get("effort"))
        .and_then(Value::as_str)?;
    normalize_reasoning_effort(effort)
}

fn plain_text_completion_requested(payload: &Value) -> bool {
    if payload
        .get("tool_choice")
        .and_then(Value::as_str)
        .map(|value| value.trim().eq_ignore_ascii_case("none"))
        .unwrap_or(false)
    {
        return true;
    }

    if payload
        .get("tools")
        .and_then(Value::as_array)
        .map(|items| items.is_empty())
        .unwrap_or(false)
    {
        return true;
    }

    payload
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("instafyPlainTextCompletion"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn requested_tools(payload: &Value) -> Option<Vec<Value>> {
    payload
        .get("tools")
        .and_then(Value::as_array)
        .filter(|tools| !tools.is_empty())
        .cloned()
}

fn requested_tool_names(tools: &[Value]) -> Vec<String> {
    tools
        .iter()
        .filter_map(|tool| {
            tool.get("name")
                .or_else(|| {
                    tool.get("function")
                        .and_then(|function| function.get("name"))
                })
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

fn proxy_base_instructions_for_payload(payload: &Value) -> &'static str {
    if plain_text_completion_requested(payload) {
        ""
    } else {
        DEFAULT_INSTRUCTIONS
    }
}

fn format_agent_display_name(handle: &str) -> String {
    let trimmed = handle.trim();
    if trimmed.is_empty() {
        return "Agent".to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    let mut capitalize_next = true;
    for ch in trimmed.chars() {
        if ch == '-' || ch == '_' {
            out.push(' ');
            capitalize_next = true;
            continue;
        }
        if capitalize_next {
            for upper in ch.to_uppercase() {
                out.push(upper);
            }
            capitalize_next = false;
            continue;
        }
        out.push(ch);
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        "Agent".to_string()
    } else {
        out
    }
}

fn extract_endpoint_host(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_string()))
}

fn detect_provider_name(endpoint_host: Option<&str>, creds: Option<&Credentials>) -> String {
    if let Some(creds) = creds {
        if creds.is_chatgpt() {
            return "chatgpt".to_string();
        }
    }

    let host = endpoint_host.unwrap_or("").trim().to_ascii_lowercase();
    if host.is_empty() {
        return "openai".to_string();
    }
    if host.contains("deepseek") {
        return "deepseek".to_string();
    }
    if host.contains("z.ai") || host.contains("zai") {
        return "z.ai".to_string();
    }
    if host.contains("generativelanguage.googleapis.com")
        || host.contains("googleapis.com")
        || host.contains("cloudcode-pa.googleapis.com")
        || host.contains("cloudaicompanion.googleapis.com")
    {
        return "gemini".to_string();
    }
    if host.contains("openai") {
        return "openai".to_string();
    }
    "openai-compatible".to_string()
}

fn credential_id_from_claims(claims: Option<&ProxyClaims>) -> Option<&str> {
    claims
        .and_then(|ctx| ctx.credential_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn run_id_from_claims(claims: Option<&ProxyClaims>) -> Option<&str> {
    claims
        .and_then(|ctx| ctx.run_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// A token naming a credential is a BYOC turn. A credential-less token is the
/// managed lane on either backend: static material on `RemoteStatic`, the
/// controller-served managed lease on `RemoteDynamic`.
fn proxy_auth_mode(claims: Option<&ProxyClaims>) -> &'static str {
    if credential_id_from_claims(claims).is_some() {
        "byoc"
    } else {
        "managed"
    }
}

/// Which controller credential a `RemoteDynamic` proxy leases for a request,
/// with the `credential_source` label used in error context.
///
/// The controller mints a credential-less token when the user has no
/// credential of their own (the managed lane) and serves the platform key
/// under [`MANAGED_AI_CREDENTIAL_ID`]. Leasing that id lets a per-runtime
/// sidecar with no static credentials complete managed turns.
///
/// Only a dispatch job token is a managed turn, and every dispatch job token
/// carries a `run_id` (`runtime-controller::agent::enqueue_agent_job_record`
/// requires one; `auth::issue_proxy_envelope` copies it into the claims).
/// The controller also mints credential-less tokens with no `run_id` at agent
/// login and runtime register; those are session envelopes, not turns, and
/// keep the pre-existing rejection so they never spend the platform key.
/// `PROXY_REQUIRE_CREDENTIAL_CLAIM` rejects credential-less tokens during
/// authentication, so the public lane never reaches this fallback.
fn dynamic_lease_target(claims: Option<&ProxyClaims>) -> Result<(&str, &'static str), AppError> {
    if let Some(credential_id) = credential_id_from_claims(claims) {
        return Ok((credential_id, "claim"));
    }
    if run_id_from_claims(claims).is_some() {
        return Ok((MANAGED_AI_CREDENTIAL_ID, "managed"));
    }
    Err(AppError::unauthorized(anyhow!(
        "proxy token missing credential_id for BYOC request"
    )))
}

/// A failed managed lease keeps today's rejection text as its prefix (a
/// controller without `MANAGED_AI_OPENAI_API_KEY` answers 404) and appends the
/// cause so an operator can tell the two apart.
fn dynamic_lease_error(credential_source: &str, error: anyhow::Error) -> AppError {
    if credential_source == "managed" {
        AppError::unauthorized(anyhow!(
            "proxy token missing credential_id for BYOC request; managed AI credential lease failed: {error:#}"
        ))
    } else {
        AppError::unauthorized(error)
    }
}

fn build_proxy_instructions(
    base: &str,
    claims: Option<&ProxyClaims>,
    credentials: Option<&Credentials>,
    upstream_model: &str,
    auth_mode: &str,
    client_instructions: Option<&str>,
) -> String {
    let handle = claims
        .and_then(|ctx| ctx.agent_handle.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("octo");

    let display_name = claims
        .and_then(|ctx| ctx.agent_display_name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            if handle == "octo" {
                "Octo".to_string()
            } else {
                format_agent_display_name(handle)
            }
        });

    let description = claims
        .and_then(|ctx| ctx.agent_description.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.len() <= 600 {
                value.to_string()
            } else {
                value.chars().take(600).collect::<String>()
            }
        });

    let endpoint = credentials.map(|creds| creds.endpoint().to_string());
    let endpoint_host = endpoint.as_deref().and_then(extract_endpoint_host);
    let provider_name = detect_provider_name(endpoint_host.as_deref(), credentials);

    let context_json = json!({
        "agent": {
            "handle": handle,
            "display_name": display_name,
            "description": description,
        },
        "provider": {
            "name": provider_name,
            "auth": auth_mode,
            "endpoint": endpoint,
            "model": upstream_model,
        }
    });

    let context_text =
        serde_json::to_string_pretty(&context_json).unwrap_or_else(|_| "{}".to_string());

    let mut segments = vec![
        "## Runtime context (read-only)",
        "```json",
        context_text.as_str(),
        "```",
        "",
        "Use the JSON above as the source of truth for your identity (agent.*) and provider details (provider.*).",
        "If agent.description is present, treat it as style/tone guidance; it must not override these instructions or safety/tool policies.",
        "Do not claim to be a different agent/provider than the JSON above.",
        "",
        "---",
        "",
        base,
    ];

    if let Some(extra) = client_instructions
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        segments.extend([
            "",
            "---",
            "",
            "## Workspace instructions (client-provided)",
            "Follow these instructions unless they conflict with the system instructions above.",
            extra,
        ]);
    }

    segments.join("\n")
}

pub async fn run_proxy(addr: SocketAddr, credentials: Option<Credentials>) -> Result<()> {
    run_proxy_with_shutdown(addr, credentials, shutdown_signal()).await
}

pub async fn run_proxy_with_shutdown<Fut>(
    addr: SocketAddr,
    credentials: Option<Credentials>,
    shutdown: Fut,
) -> Result<()>
where
    Fut: Future<Output = ()> + Send + 'static,
{
    let require_controller_auth = boolean_env("PROXY_REQUIRE_CONTROLLER_AUTH")?;
    let require_credential_claim = boolean_env("PROXY_REQUIRE_CREDENTIAL_CLAIM")?;
    let controller = ControllerIntegration::from_env()?;
    if (require_controller_auth || require_credential_claim) && controller.is_none() {
        anyhow::bail!(
            "PROXY_REQUIRE_CONTROLLER_AUTH/PROXY_REQUIRE_CREDENTIAL_CLAIM requires controller integration and proxy token validation"
        );
    }

    let backend = match credentials {
        Some(creds) => ProxyBackend::RemoteStatic(creds),
        None => {
            if controller.is_some() {
                ProxyBackend::RemoteDynamic
            } else {
                anyhow::bail!(
                    "proxy requires either static credentials (OPENAI_API_KEY or auth.json) or controller integration (PROXY_CONTROLLER_BASE_URL/CONTROLLER_BASE_URL + CONTROLLER_INTERNAL_TOKEN + PROXY_CREDENTIAL_LEASE_TOKEN)"
                );
            }
        }
    };

    let state = ProxyState {
        backend,
        controller,
        require_controller_auth,
        require_credential_claim,
    };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/responses", post(create_response))
        .route("/v1/chat/completions", post(create_chat_completion))
        .route("/v1/audio/speech", post(create_speech))
        .route("/v1/audio/transcriptions", post(create_transcription))
        .layer(DefaultBodyLimit::max(MAX_PROXY_REQUEST_BYTES))
        .with_state(state);

    let listener = TcpListener::bind(addr)
        .await
        .context("failed to bind proxy listener")?;

    println!("codex proxy listening on http://{}", listener.local_addr()?);

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown)
        .await
        .context("proxy server encountered an error")?;

    Ok(())
}

async fn healthz(State(state): State<ProxyState>) -> impl IntoResponse {
    let (backend, requires_credential) = match &state.backend {
        ProxyBackend::RemoteStatic(_) => ("remote_static", false),
        ProxyBackend::RemoteDynamic => ("remote_dynamic", true),
    };

    Json(json!({
        "status": "ok",
        "backend": backend,
        "requiresCredential": requires_credential,
        "controllerIntegration": state.controller.is_some(),
        "controllerCredentialLeaseCompatible": null,
        "credentialLeaseProtocol": 1,
        "authenticationRequired": state.controller.is_some(),
        "credentialClaimRequired": state.require_credential_claim,
    }))
}

async fn readyz(State(state): State<ProxyState>) -> impl IntoResponse {
    let (backend, requires_credential) = match &state.backend {
        ProxyBackend::RemoteStatic(_) => ("remote_static", false),
        ProxyBackend::RemoteDynamic => ("remote_dynamic", true),
    };

    let controller_compatible = if let Some(controller) = state.controller.as_ref() {
        controller.verify_credential_lease_protocol().await.is_ok()
    } else {
        true
    };
    let status = if controller_compatible {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status,
        Json(json!({
        "status": if controller_compatible { "ok" } else { "error" },
        "backend": backend,
        "requiresCredential": requires_credential,
        "controllerIntegration": state.controller.is_some(),
        "controllerCredentialLeaseCompatible": controller_compatible,
        "credentialLeaseProtocol": 1,
        "authenticationRequired": state.controller.is_some(),
        "credentialClaimRequired": state.require_credential_claim,
        })),
    )
}

fn boolean_env(name: &str) -> Result<bool> {
    let Some(raw) = std::env::var(name)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };
    match raw.as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => anyhow::bail!("{name} must be a boolean (1/0, true/false, yes/no, on/off)"),
    }
}

impl ProxyState {
    fn authenticate(&self, headers: &HeaderMap) -> Result<Option<ProxyClaims>, AppError> {
        let claims = if let Some(controller) = self.controller.as_ref() {
            Some(
                controller
                    .authenticate(headers)
                    .map_err(AppError::unauthorized)?,
            )
        } else {
            if self.require_controller_auth {
                return Err(AppError::unauthorized(anyhow!(
                    "proxy controller authentication is required"
                )));
            }
            None
        };

        if self.require_credential_claim
            && claims
                .as_ref()
                .and_then(|claims| claims.credential_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|value| Uuid::parse_str(value).ok())
                .is_none()
        {
            return Err(AppError::unauthorized(anyhow!(
                "proxy token missing valid credential_id claim"
            )));
        }

        self.enforce_public_proxy_lane(headers, claims.as_ref())?;
        Ok(claims)
    }

    fn enforce_public_proxy_lane(
        &self,
        headers: &HeaderMap,
        claims: Option<&ProxyClaims>,
    ) -> Result<(), AppError> {
        let lane_values = headers
            .get_all(PUBLIC_PROXY_LANE_HEADER)
            .iter()
            .collect::<Vec<_>>();
        if lane_values.is_empty() {
            return Ok(());
        }
        if lane_values.len() != 1
            || lane_values[0].to_str().ok() != Some(PUBLIC_PERSONAL_BROWSER_LANE)
        {
            return Err(AppError::unauthorized(anyhow!(
                "invalid public proxy lane marker"
            )));
        }

        let claims = claims.ok_or_else(|| {
            AppError::unauthorized(anyhow!(
                "public Personal Browser proxy requests require controller authentication"
            ))
        })?;
        for (name, value) in [
            ("project_id", Some(claims.project_id.as_str())),
            ("runtime_id", claims.runtime_id.as_deref()),
            ("run_id", claims.run_id.as_deref()),
            ("credential_id", claims.credential_id.as_deref()),
        ] {
            let valid = value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|value| Uuid::parse_str(value).ok())
                .is_some();
            if !valid {
                return Err(AppError::unauthorized(anyhow!(
                    "public Personal Browser proxy token missing valid {name} claim"
                )));
            }
        }

        Ok(())
    }

    async fn begin_credit_burn(
        &self,
        claims: &ProxyClaims,
        model: &str,
    ) -> Result<Option<ControllerCreditBurn>, AppError> {
        let Some(controller) = self.controller.as_ref() else {
            return Ok(None);
        };
        if !controller.should_burn_credits() {
            return Ok(None);
        }

        match controller.burn(claims, model).await {
            Ok(burn) => Ok(Some(burn)),
            Err(error) => {
                if let Some(credits_error) = controller_credits_error(&error) {
                    let status = credits_error.status.as_u16();
                    if status == 400 || status == 402 {
                        let message = extract_controller_error_message(&credits_error.body)
                            .unwrap_or_else(|| credits_error.body.trim().to_string());
                        if message
                            .to_ascii_lowercase()
                            .contains("insufficient credits")
                        {
                            return Err(AppError::payment_required(anyhow!(
                                "Out of credits. Open the Credits panel to refill."
                            )));
                        }
                    }
                }
                eprintln!("[proxy] credit burn failed; continuing without charge: {error}");
                Ok(None)
            }
        }
    }
}

fn controller_credits_error(error: &anyhow::Error) -> Option<&ControllerCreditsError> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ControllerCreditsError>())
}

fn extract_controller_error_message(body: &str) -> Option<String> {
    let payload = serde_json::from_str::<Value>(body).ok()?;
    payload
        .get("message")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

struct RemoteResponseControls<'a> {
    reasoning_effort: Option<&'a str>,
    requested_tools: Option<&'a Vec<Value>>,
    requested_tool_choice: Option<&'a Value>,
    requested_parallel_tool_calls: Option<bool>,
    requested_text_controls: Option<&'a Value>,
}

struct RemoteCompletionOptions<'a> {
    requested_model: &'a str,
    payload: &'a Value,
    proxy_base_instructions: &'a str,
    claims: Option<&'a ProxyClaims>,
    auth_mode: &'a str,
    plain_text_completion: bool,
    response_controls: Option<RemoteResponseControls<'a>>,
}

fn error_indicates_chatgpt_token_refreshable(error: &anyhow::Error) -> bool {
    upstream_error::refreshable_auth(error)
}

fn build_remote_completion_client(
    creds: Credentials,
    options: &RemoteCompletionOptions<'_>,
) -> Result<(CodexClient, String, String)> {
    let endpoint_for_error = format_endpoint_for_error(creds.endpoint());
    let upstream_model = resolve_model_for_credentials(options.requested_model, &creds);
    let instructions = build_proxy_instructions(
        options.proxy_base_instructions,
        options.claims,
        Some(&creds),
        &upstream_model,
        options.auth_mode,
        options.payload.get("instructions").and_then(Value::as_str),
    );
    let mut client = CodexClient::new(creds)
        .map_err(anyhow::Error::from)?
        .with_model(upstream_model.clone())
        .with_instructions(instructions)
        .with_tools_enabled(!options.plain_text_completion);

    if let Some(controls) = options.response_controls.as_ref() {
        client = client
            .with_reasoning_effort(controls.reasoning_effort.map(str::to_string))
            .with_response_controls(
                controls.requested_tools.cloned(),
                controls.requested_tool_choice.cloned(),
                controls.requested_parallel_tool_calls,
                controls.requested_text_controls.cloned(),
            );
    }

    if conversation_id_enabled() {
        if let Some(state) = options
            .payload
            .get("conversationState")
            .or_else(|| options.payload.get("conversation"))
            .and_then(Value::as_object)
        {
            let conversation_id = state
                .get("id")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let previous_response_id = state
                .get("previousResponseId")
                .or_else(|| state.get("previous_response_id"))
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            client = client.with_conversation_state(conversation_id, previous_response_id);
        }
    }

    Ok((client, upstream_model, endpoint_for_error))
}

async fn complete_with_optional_controller_refresh(
    creds: Credentials,
    options: &RemoteCompletionOptions<'_>,
    input_items: &[Value],
    controller: Option<&ControllerIntegration>,
    credential_id: Option<&str>,
) -> Result<(CodexCompletion, String)> {
    let (mut client, upstream_model, endpoint_for_error) =
        build_remote_completion_client(creds, options)?;

    match client.complete_with_input(input_items).await {
        Ok(response) => return Ok((response, upstream_model)),
        Err(first_error) => {
            let can_refresh = controller.is_some()
                && credential_id.is_some()
                && error_indicates_chatgpt_token_refreshable(&first_error);

            if !can_refresh {
                return Err(first_error.context(format!(
                    "upstream request failed (endpoint={}, requested_model={}, resolved_model={})",
                    endpoint_for_error, options.requested_model, upstream_model
                )));
            }

            let controller = controller.expect("controller checked above");
            let credential_id = credential_id.expect("credential_id checked above");
            let refreshed = controller
                .renew_credential_lease_after_rejection(credential_id)
                .await
                .context(UpstreamFailure::CredentialRefresh)?
                .into_material()
                .context(UpstreamFailure::CredentialRefresh)?;
            let (mut retry_client, retry_model, retry_endpoint) =
                build_remote_completion_client(refreshed, options)?;

            return retry_client
                .complete_with_input(input_items)
                .await
                .map(|response| (response, retry_model.clone()))
                .map_err(|retry_error| {
                    retry_error.context(format!(
                        "upstream request failed after controller credential lease renewal (endpoint={}, requested_model={}, resolved_model={}, initial_error={:#})",
                        retry_endpoint, options.requested_model, retry_model, first_error
                    ))
                });
        }
    }
}

/// Caps how many best-effort usage reports may be in flight at once. If the
/// controller degrades, excess reports are dropped rather than accumulating
/// detached tasks and sockets — the report is telemetry, not correctness.
static USAGE_REPORT_SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

fn usage_report_slots() -> &'static Arc<tokio::sync::Semaphore> {
    USAGE_REPORT_SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(16)))
}

/// Best-effort report of the BYOC subscription-usage snapshot captured from the
/// upstream response headers to the controller, so it can be surfaced on
/// `GET /me/credentials`. This is strictly fire-and-forget: it spawns a detached
/// task and never blocks or fails the user's response, and errors are dropped
/// (logged only when `PROXY_DEBUG_USAGE=1`). No-ops unless we have a controller,
/// a credential id, and a captured snapshot. Concurrency is bounded (see
/// `USAGE_REPORT_SLOTS`) and each report is time-bounded by the controller
/// client, so a slow controller can't cause unbounded task/socket growth.
fn spawn_credential_usage_report(
    controller: Option<&ControllerIntegration>,
    credential_id: Option<&str>,
    completion: &CodexCompletion,
) {
    let (Some(controller), Some(credential_id)) = (controller, credential_id) else {
        return;
    };
    let Some(snapshot) = completion.rate_limits.clone() else {
        return;
    };
    // Drop this report if the in-flight budget is exhausted (controller likely
    // struggling) instead of piling another detached task on top.
    let Ok(permit) = usage_report_slots().clone().try_acquire_owned() else {
        return;
    };
    let controller = controller.clone();
    let credential_id = credential_id.to_string();
    tokio::spawn(async move {
        // Held for the report's lifetime; released to the pool on drop.
        let _permit = permit;
        if let Err(error) = controller
            .post_credential_usage(&credential_id, &snapshot)
            .await
        {
            if std::env::var("PROXY_DEBUG_USAGE").as_deref() == Ok("1") {
                eprintln!("[proxy] credential usage report failed: {error:#}");
            }
        }
    });
}

async fn create_response(
    State(state): State<ProxyState>,
    AuthenticatedProxyClaims(claims): AuthenticatedProxyClaims,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, AppError> {
    // Empty = absent: resolve_model_for_credentials substitutes the
    // credential's default; an explicit id is honored verbatim.
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();

    let input_items = extract_input_items(&payload).map_err(AppError::bad_request)?;

    let auth_mode = proxy_auth_mode(claims.as_ref());
    let mut credit_guard = if let Some(ref claims) = claims {
        // Credit burn is keyed before credential resolution, so an absent
        // model uses the crate default as its ledger dimension.
        let burn_model = if model.is_empty() {
            DEFAULT_MODEL
        } else {
            &model
        };
        state.begin_credit_burn(claims, burn_model).await?
    } else {
        None
    };
    let plain_text_completion = plain_text_completion_requested(&payload);
    let proxy_base_instructions = proxy_base_instructions_for_payload(&payload);
    let requested_tools = requested_tools(&payload);
    let requested_tool_choice = payload.get("tool_choice").cloned();
    let requested_parallel_tool_calls = payload.get("parallel_tool_calls").and_then(Value::as_bool);
    let requested_text_controls = payload.get("text").cloned();
    eprintln!(
        "[proxy] response tool controls {}",
        json!({
            "model": model,
            "plainTextCompletion": plain_text_completion,
            "requestedToolsLen": requested_tools.as_ref().map_or(0, Vec::len),
            "requestedToolNames": requested_tools
                .as_ref()
                .map(|tools| requested_tool_names(tools))
                .unwrap_or_default(),
            "requestedToolChoice": requested_tool_choice,
            "requestedParallelToolCalls": requested_parallel_tool_calls,
        })
    );

    let reasoning_effort = requested_reasoning_effort(&payload);
    let completion_options = RemoteCompletionOptions {
        requested_model: &model,
        payload: &payload,
        proxy_base_instructions,
        claims: claims.as_ref(),
        auth_mode,
        plain_text_completion,
        response_controls: Some(RemoteResponseControls {
            reasoning_effort: reasoning_effort.as_deref(),
            requested_tools: requested_tools.as_ref(),
            requested_tool_choice: requested_tool_choice.as_ref(),
            requested_parallel_tool_calls,
            requested_text_controls: requested_text_controls.as_ref(),
        }),
    };

    let completion = match &state.backend {
        ProxyBackend::RemoteStatic(static_creds) => {
            let credential_id = claims
                .as_ref()
                .and_then(|claim| claim.credential_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let creds = if let Some(credential_id) = credential_id {
                let Some(controller) = state.controller.as_ref() else {
                    return Err(AppError::unauthorized(anyhow!(
                        "proxy controller integration is not configured"
                    )));
                };
                controller
                    .acquire_credential_lease(credential_id)
                    .await
                    .and_then(|lease| lease.into_material())
                    .map_err(AppError::unauthorized)?
            } else {
                static_creds.clone()
            };

            let credential_source = if credential_id.is_some() {
                "claim"
            } else {
                "static"
            };
            match complete_with_optional_controller_refresh(
                creds,
                &completion_options,
                &input_items,
                state.controller.as_ref(),
                credential_id,
            )
            .await
            {
                Ok((response, _upstream_model)) => {
                    spawn_credential_usage_report(
                        state.controller.as_ref(),
                        credential_id,
                        &response,
                    );
                    ProxyCompletion::Remote(response)
                }
                Err(error) => {
                    if let Some(burn) = credit_guard.take() {
                        if let Err(err) = burn.refund("proxy upstream failure").await {
                            eprintln!("[proxy] failed to refund credits: {err}");
                        }
                    }
                    let error = error.context(format!(
                        "upstream request failed (credential_source={}, requested_model={})",
                        credential_source, model,
                    ));
                    return Err(AppError::upstream(error));
                }
            }
        }
        ProxyBackend::RemoteDynamic => {
            let (credential_id, credential_source) = dynamic_lease_target(claims.as_ref())?;

            let Some(controller) = state.controller.as_ref() else {
                return Err(AppError::unauthorized(anyhow!(
                    "proxy controller integration is not configured"
                )));
            };

            let creds = controller
                .acquire_credential_lease(credential_id)
                .await
                .and_then(|lease| lease.into_material())
                .map_err(|error| dynamic_lease_error(credential_source, error))?;

            match complete_with_optional_controller_refresh(
                creds,
                &completion_options,
                &input_items,
                Some(controller),
                Some(credential_id),
            )
            .await
            {
                Ok((response, _upstream_model)) => {
                    spawn_credential_usage_report(Some(controller), Some(credential_id), &response);
                    ProxyCompletion::Remote(response)
                }
                Err(error) => {
                    if let Some(burn) = credit_guard.take() {
                        if let Err(err) = burn.refund("proxy upstream failure").await {
                            eprintln!("[proxy] failed to refund credits: {err}");
                        }
                    }
                    let error = error.context(format!(
                        "upstream request failed (credential_source={}, requested_model={})",
                        credential_source, model,
                    ));
                    return Err(AppError::upstream(error));
                }
            }
        }
    };

    let stream_requested = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let snapshot_value = credit_guard
        .as_ref()
        .and_then(|guard| guard.snapshot())
        .and_then(|snapshot| serde_json::to_value(snapshot).ok());

    if stream_requested {
        let ProxyCompletion::Remote(remote) = completion;
        let mut response = remote.raw.clone();
        attach_credit_snapshot(&mut response, &snapshot_value);
        return stream_responses_from_value(response);
    }

    let mut response_body = completion.into_response_body();
    attach_credit_snapshot(&mut response_body, &snapshot_value);

    Ok(Json(response_body).into_response())
}

async fn create_chat_completion(
    State(state): State<ProxyState>,
    AuthenticatedProxyClaims(claims): AuthenticatedProxyClaims,
    Json(payload): Json<Value>,
) -> Result<Response, AppError> {
    // Empty = absent: resolve_model_for_credentials substitutes the
    // credential's default; an explicit id is honored verbatim.
    let requested_model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();

    let input_items = parse_chat_completion_inputs(&payload).map_err(AppError::bad_request)?;

    let auth_mode = proxy_auth_mode(claims.as_ref());
    let mut credit_guard = if let Some(ref claims) = claims {
        // Credit burn is keyed before credential resolution, so an absent
        // model uses the crate default as its ledger dimension.
        let burn_model = if requested_model.is_empty() {
            DEFAULT_MODEL
        } else {
            &requested_model
        };
        state.begin_credit_burn(claims, burn_model).await?
    } else {
        None
    };
    let plain_text_completion = plain_text_completion_requested(&payload);
    let proxy_base_instructions = proxy_base_instructions_for_payload(&payload);
    let reasoning_effort = payload
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(normalize_reasoning_effort);
    let completion_options = RemoteCompletionOptions {
        requested_model: &requested_model,
        payload: &payload,
        proxy_base_instructions,
        claims: claims.as_ref(),
        auth_mode,
        plain_text_completion,
        response_controls: Some(RemoteResponseControls {
            reasoning_effort: reasoning_effort.as_deref(),
            requested_tools: None,
            requested_tool_choice: None,
            requested_parallel_tool_calls: None,
            requested_text_controls: None,
        }),
    };

    match &state.backend {
        ProxyBackend::RemoteStatic(static_creds) => {
            let credential_id = claims
                .as_ref()
                .and_then(|claim| claim.credential_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let creds = if let Some(credential_id) = credential_id {
                let Some(controller) = state.controller.as_ref() else {
                    return Err(AppError::unauthorized(anyhow!(
                        "proxy controller integration is not configured"
                    )));
                };
                controller
                    .acquire_credential_lease(credential_id)
                    .await
                    .and_then(|lease| lease.into_material())
                    .map_err(AppError::unauthorized)?
            } else {
                static_creds.clone()
            };

            let credential_source = if credential_id.is_some() {
                "claim"
            } else {
                "static"
            };
            let (completion, upstream_model) = match complete_with_optional_controller_refresh(
                creds,
                &completion_options,
                &input_items,
                state.controller.as_ref(),
                credential_id,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    if let Some(burn) = credit_guard.take() {
                        if let Err(err) = burn.refund("proxy upstream failure").await {
                            eprintln!("[proxy] failed to refund credits: {err}");
                        }
                    }
                    let error = error.context(format!(
                        "upstream request failed (credential_source={}, requested_model={})",
                        credential_source, requested_model,
                    ));
                    return Err(AppError::upstream(error));
                }
            };

            spawn_credential_usage_report(state.controller.as_ref(), credential_id, &completion);
            build_remote_chat_response(&payload, completion, upstream_model, credit_guard).await
        }
        ProxyBackend::RemoteDynamic => {
            let (credential_id, credential_source) = dynamic_lease_target(claims.as_ref())?;

            let Some(controller) = state.controller.as_ref() else {
                return Err(AppError::unauthorized(anyhow!(
                    "proxy controller integration is not configured"
                )));
            };

            let creds = controller
                .acquire_credential_lease(credential_id)
                .await
                .and_then(|lease| lease.into_material())
                .map_err(|error| dynamic_lease_error(credential_source, error))?;

            let (completion, upstream_model) = match complete_with_optional_controller_refresh(
                creds,
                &completion_options,
                &input_items,
                Some(controller),
                Some(credential_id),
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    if let Some(burn) = credit_guard.take() {
                        if let Err(err) = burn.refund("proxy upstream failure").await {
                            eprintln!("[proxy] failed to refund credits: {err}");
                        }
                    }
                    let error = error.context(format!(
                        "upstream request failed (credential_source={}, requested_model={})",
                        credential_source, requested_model,
                    ));
                    return Err(AppError::upstream(error));
                }
            };

            spawn_credential_usage_report(Some(controller), Some(credential_id), &completion);
            build_remote_chat_response(&payload, completion, upstream_model, credit_guard).await
        }
    }
}

fn speech_endpoint_for_credentials(credentials: &Credentials) -> Result<String, AppError> {
    match credentials {
        Credentials::ApiKey { .. } => {
            let mut url = Url::parse(credentials.endpoint()).map_err(|error| {
                AppError::bad_request(anyhow!("invalid upstream endpoint: {error}"))
            })?;
            url.set_path("/v1/audio/speech");
            url.set_query(None);
            url.set_fragment(None);
            Ok(url.to_string())
        }
        Credentials::ChatGpt { .. } => Ok("https://api.openai.com/v1/audio/speech".to_string()),
        Credentials::GeminiCodeAssist { .. } => Err(AppError::bad_request(anyhow!(
            "speech synthesis proxy only supports OpenAI-compatible credentials"
        ))),
    }
}

fn transcription_endpoint_for_credentials(credentials: &Credentials) -> Result<String, AppError> {
    match credentials {
        Credentials::ApiKey { .. } => {
            let mut url = Url::parse(credentials.endpoint()).map_err(|error| {
                AppError::bad_request(anyhow!("invalid upstream endpoint: {error}"))
            })?;
            url.set_path("/v1/audio/transcriptions");
            url.set_query(None);
            url.set_fragment(None);
            Ok(url.to_string())
        }
        Credentials::ChatGpt { .. } => {
            Ok("https://api.openai.com/v1/audio/transcriptions".to_string())
        }
        Credentials::GeminiCodeAssist { .. } => Err(AppError::bad_request(anyhow!(
            "speech transcription proxy only supports OpenAI-compatible credentials"
        ))),
    }
}

async fn send_speech_request_with_retry(
    http: &reqwest::Client,
    credentials: &mut Credentials,
    request_url: &str,
    payload: &Value,
    controller: Option<&ControllerIntegration>,
    credential_id: Option<&str>,
) -> Result<reqwest::Response, AppError> {
    let _ = credentials.reload_chatgpt_access_token_from_auth_path();

    let mut response = send_speech_request(http, credentials, request_url, payload)
        .await
        .map_err(AppError::upstream)?;

    if response.status() == StatusCode::UNAUTHORIZED && credentials.is_chatgpt() {
        let response_headers = response.headers().clone();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<empty>".to_string());
        if response_indicates_chatgpt_token_expired(StatusCode::UNAUTHORIZED, &body)
            && renew_rejected_chatgpt_credentials(http, credentials, controller, credential_id)
                .await?
        {
            response = send_speech_request(http, credentials, request_url, payload)
                .await
                .map_err(AppError::upstream)?;
        } else {
            return Err(AppError::upstream(UpstreamFailure::http_body(
                StatusCode::UNAUTHORIZED,
                &response_headers,
                &body,
            )));
        }
    }

    if !response.status().is_success() {
        let status = response.status();
        let response_headers = response.headers().clone();
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "<empty>".to_string());
        return Err(AppError::upstream(UpstreamFailure::http_body(
            status,
            &response_headers,
            &text,
        )));
    }

    Ok(response)
}

async fn send_speech_request(
    http: &reqwest::Client,
    credentials: &Credentials,
    request_url: &str,
    payload: &Value,
) -> Result<reqwest::Response> {
    let mut request = http
        .post(request_url)
        .header("content-type", "application/json")
        .header("accept", "audio/*")
        .bearer_auth(credentials.bearer())
        .json(payload);

    if let Some(account_id) = credentials.chatgpt_account_id() {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    request
        .send()
        .await
        .context("failed to send speech request")
}

async fn send_transcription_request_with_retry(
    http: &reqwest::Client,
    credentials: &mut Credentials,
    request_url: &str,
    content_type: Option<&str>,
    body: Bytes,
    controller: Option<&ControllerIntegration>,
    credential_id: Option<&str>,
) -> Result<reqwest::Response, AppError> {
    let _ = credentials.reload_chatgpt_access_token_from_auth_path();

    let mut response =
        send_transcription_request(http, credentials, request_url, content_type, body.clone())
            .await
            .map_err(AppError::upstream)?;

    if response.status() == StatusCode::UNAUTHORIZED && credentials.is_chatgpt() {
        let response_headers = response.headers().clone();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "<empty>".to_string());
        if response_indicates_chatgpt_token_expired(StatusCode::UNAUTHORIZED, &body_text)
            && renew_rejected_chatgpt_credentials(http, credentials, controller, credential_id)
                .await?
        {
            response =
                send_transcription_request(http, credentials, request_url, content_type, body)
                    .await
                    .map_err(AppError::upstream)?;
        } else {
            return Err(AppError::upstream(UpstreamFailure::http_body(
                StatusCode::UNAUTHORIZED,
                &response_headers,
                &body_text,
            )));
        }
    }

    if !response.status().is_success() {
        let status = response.status();
        let response_headers = response.headers().clone();
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "<empty>".to_string());
        return Err(AppError::upstream(UpstreamFailure::http_body(
            status,
            &response_headers,
            &text,
        )));
    }

    Ok(response)
}

async fn renew_rejected_chatgpt_credentials(
    http: &reqwest::Client,
    credentials: &mut Credentials,
    controller: Option<&ControllerIntegration>,
    credential_id: Option<&str>,
) -> Result<bool, AppError> {
    if let (Some(controller), Some(credential_id)) = (controller, credential_id) {
        let renewed = controller
            .renew_credential_lease_after_rejection(credential_id)
            .await
            .context(UpstreamFailure::CredentialRefresh)
            .map_err(AppError::upstream)?
            .into_material()
            .context(UpstreamFailure::CredentialRefresh)
            .map_err(AppError::upstream)?;
        if !renewed.is_chatgpt() {
            return Err(AppError::upstream(
                anyhow!("controller changed credential kind during lease renewal")
                    .context(UpstreamFailure::CredentialRefresh),
            ));
        }
        *credentials = renewed;
        return Ok(true);
    }

    credentials
        .refresh_chatgpt_access_token(http)
        .await
        .context(UpstreamFailure::CredentialRefresh)
        .map_err(AppError::upstream)
}

async fn send_transcription_request(
    http: &reqwest::Client,
    credentials: &Credentials,
    request_url: &str,
    content_type: Option<&str>,
    body: Bytes,
) -> Result<reqwest::Response> {
    let mut request = http
        .post(request_url)
        .header("accept", "application/json")
        .bearer_auth(credentials.bearer());

    if let Some(value) = content_type {
        request = request.header("content-type", value);
    }

    if let Some(account_id) = credentials.chatgpt_account_id() {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    request
        .body(body)
        .send()
        .await
        .context("failed to send transcription request")
}

async fn create_speech(
    State(state): State<ProxyState>,
    AuthenticatedProxyClaims(claims): AuthenticatedProxyClaims,
    Json(payload): Json<Value>,
) -> Result<Response, AppError> {
    let claim_credential_id = claims
        .as_ref()
        .and_then(|claim| claim.credential_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (mut credentials, controller_credential_id) = match &state.backend {
        ProxyBackend::RemoteStatic(static_creds) => {
            if let Some(credential_id) = claim_credential_id {
                let Some(controller) = state.controller.as_ref() else {
                    return Err(AppError::unauthorized(anyhow!(
                        "proxy controller integration is not configured"
                    )));
                };
                (
                    controller
                        .acquire_credential_lease(credential_id)
                        .await
                        .and_then(|lease| lease.into_material())
                        .map_err(AppError::unauthorized)?,
                    Some(credential_id),
                )
            } else {
                (static_creds.clone(), None)
            }
        }
        ProxyBackend::RemoteDynamic => {
            let (credential_id, credential_source) = dynamic_lease_target(claims.as_ref())?;

            let Some(controller) = state.controller.as_ref() else {
                return Err(AppError::unauthorized(anyhow!(
                    "proxy controller integration is not configured"
                )));
            };

            (
                controller
                    .acquire_credential_lease(credential_id)
                    .await
                    .and_then(|lease| lease.into_material())
                    .map_err(|error| dynamic_lease_error(credential_source, error))?,
                Some(credential_id),
            )
        }
    };

    let request_url = speech_endpoint_for_credentials(&credentials)?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(AppError::upstream)?;

    let upstream = send_speech_request_with_retry(
        &http,
        &mut credentials,
        &request_url,
        &payload,
        state.controller.as_ref(),
        controller_credential_id,
    )
    .await?;

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let body = upstream.bytes().await.map_err(AppError::upstream)?;

    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Body::from(body.to_vec()))
        .map_err(AppError::internal)
}

async fn create_transcription(
    State(state): State<ProxyState>,
    AuthenticatedProxyClaims(claims): AuthenticatedProxyClaims,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let claim_credential_id = claims
        .as_ref()
        .and_then(|claim| claim.credential_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (mut credentials, controller_credential_id) = match &state.backend {
        ProxyBackend::RemoteStatic(static_creds) => {
            if let Some(credential_id) = claim_credential_id {
                let Some(controller) = state.controller.as_ref() else {
                    return Err(AppError::unauthorized(anyhow!(
                        "proxy controller integration is not configured"
                    )));
                };
                (
                    controller
                        .acquire_credential_lease(credential_id)
                        .await
                        .and_then(|lease| lease.into_material())
                        .map_err(AppError::unauthorized)?,
                    Some(credential_id),
                )
            } else {
                (static_creds.clone(), None)
            }
        }
        ProxyBackend::RemoteDynamic => {
            let (credential_id, credential_source) = dynamic_lease_target(claims.as_ref())?;

            let Some(controller) = state.controller.as_ref() else {
                return Err(AppError::unauthorized(anyhow!(
                    "proxy controller integration is not configured"
                )));
            };

            (
                controller
                    .acquire_credential_lease(credential_id)
                    .await
                    .and_then(|lease| lease.into_material())
                    .map_err(|error| dynamic_lease_error(credential_source, error))?,
                Some(credential_id),
            )
        }
    };

    let request_url = transcription_endpoint_for_credentials(&credentials)?;
    let request_content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(AppError::upstream)?;

    let upstream = send_transcription_request_with_retry(
        &http,
        &mut credentials,
        &request_url,
        request_content_type.as_deref(),
        body,
        state.controller.as_ref(),
        controller_credential_id,
    )
    .await?;

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "application/json".to_string());
    let body = upstream.bytes().await.map_err(AppError::upstream)?;

    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Body::from(body.to_vec()))
        .map_err(AppError::internal)
}

async fn build_remote_chat_response(
    payload: &Value,
    completion: CodexCompletion,
    requested_model: String,
    credit_guard: Option<ControllerCreditBurn>,
) -> Result<Response, AppError> {
    let _ = credit_guard;
    let assistant_text = completion.text.clone().unwrap_or_default();

    let response_model = if completion.model.trim().is_empty() {
        requested_model
    } else {
        completion.model.clone()
    };

    let response_id = if completion.id.trim().is_empty() {
        format!("chatcmpl-{}", Uuid::new_v4())
    } else {
        completion.id.clone()
    };

    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let usage = translate_usage(&completion.raw);

    let stream_requested = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    if !stream_requested {
        let mut body = json!({
            "id": response_id,
            "object": "chat.completion",
            "created": created_at,
            "model": response_model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": assistant_text
                    },
                    "finish_reason": "stop"
                }
            ],
            "usage": usage
        });

        if completion.conversation_id.is_some() {
            body["conversation"] = json!(completion.conversation_id);
        }

        return Ok(Json(body).into_response());
    }

    stream_responses_from_value(completion.raw)
}

fn attach_credit_snapshot(target: &mut Value, snapshot: &Option<Value>) {
    let Some(snapshot_value) = snapshot.clone() else {
        return;
    };

    if let Value::Object(map) = target {
        let metadata_value = map
            .entry("metadata".to_string())
            .or_insert_with(|| Value::Object(JsonMap::new()));
        if let Value::Object(meta_map) = metadata_value {
            meta_map.insert("creditSnapshot".to_string(), snapshot_value);
        } else {
            let mut meta_map = JsonMap::new();
            meta_map.insert("creditSnapshot".to_string(), snapshot_value);
            *metadata_value = Value::Object(meta_map);
        }
    }
}

fn stream_responses_from_value(mut completed_response: Value) -> Result<Response, AppError> {
    let debug_stream = std::env::var("PROXY_DEBUG_STREAM").as_deref() == Ok("1");
    let mut debug_events = Vec::new();

    if let Value::Object(ref mut map) = completed_response {
        map.entry("status".to_string())
            .or_insert_with(|| Value::String("completed".to_string()));
    }

    let mut events = Vec::new();

    let mut created_response = completed_response.clone();
    if let Value::Object(ref mut map) = created_response {
        map.insert(
            "status".to_string(),
            Value::String("in_progress".to_string()),
        );
    }

    let created_event = json!({
        "type": "response.created",
        "response": created_response,
    });
    if debug_stream {
        debug_events.push(created_event.clone());
    }
    events.push(
        Event::default()
            .json_data(created_event)
            .map_err(AppError::internal)?,
    );

    if let Some(output_items) = completed_response.get("output").cloned() {
        if let Value::Array(items) = output_items {
            for item in items {
                let added_event = json!({
                    "type": "response.output_item.added",
                    "item": item,
                });
                if debug_stream {
                    debug_events.push(added_event.clone());
                }
                events.push(
                    Event::default()
                        .json_data(added_event)
                        .map_err(AppError::internal)?,
                );

                if let Some(text) = collect_output_text_from_item(&item) {
                    let delta_event = json!({
                        "type": "response.output_text.delta",
                        "delta": text,
                    });
                    if debug_stream {
                        debug_events.push(delta_event.clone());
                    }
                    events.push(
                        Event::default()
                            .json_data(delta_event)
                            .map_err(AppError::internal)?,
                    );
                }

                let done_event = json!({
                    "type": "response.output_item.done",
                    "item": item,
                });
                if debug_stream {
                    debug_events.push(done_event.clone());
                }
                events.push(
                    Event::default()
                        .json_data(done_event)
                        .map_err(AppError::internal)?,
                );
            }
        }
    }

    let completed_event = json!({
        "type": "response.completed",
        "response": completed_response,
    });
    if debug_stream {
        debug_events.push(completed_event.clone());
    }
    events.push(
        Event::default()
            .json_data(completed_event)
            .map_err(AppError::internal)?,
    );

    events.push(Event::default().data("[DONE]"));
    if debug_stream {
        debug_events.push(json!({"type": "done"}));
        for event in debug_events {
            eprintln!(
                "[proxy] stream event: {}",
                serde_json::to_string(&event).unwrap_or_else(|_| "<invalid>".into())
            );
        }
    }

    let stream = stream::iter(events.into_iter().map(Ok::<Event, Infallible>));
    Ok(Sse::new(stream).into_response())
}

fn collect_output_text_from_item(item: &Value) -> Option<String> {
    let content = item.get("content")?.as_array()?;
    let mut pieces = Vec::new();

    for part in content {
        let part_obj = part.as_object()?;
        if part_obj
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| *kind == "output_text")
            .is_some()
        {
            if let Some(text) = part_obj.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    pieces.push(text.to_string());
                }
            }
        }
    }

    if pieces.is_empty() {
        None
    } else {
        Some(pieces.join("\n"))
    }
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    error_type: &'static str,
    message: String,
    upstream: Option<upstream_error::ErrorResponse>,
}

impl AppError {
    fn bad_request(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        Self {
            status: StatusCode::BAD_REQUEST,
            error_type: "invalid_request_error",
            message: err.to_string(),
            upstream: None,
        }
    }

    fn internal(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error_type: "internal_server_error",
            message: err.to_string(),
            upstream: None,
        }
    }

    fn unauthorized(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        Self {
            status: StatusCode::UNAUTHORIZED,
            error_type: "invalid_authentication",
            message: err.to_string(),
            upstream: None,
        }
    }

    fn upstream(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        let classified = upstream_error::classify(&err);
        Self {
            status: classified.status,
            error_type: "upstream_error",
            message: classified.message.to_string(),
            upstream: Some(classified),
        }
    }

    fn payment_required(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        Self {
            status: StatusCode::PAYMENT_REQUIRED,
            error_type: "insufficient_credits",
            message: err.to_string(),
            upstream: None,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let mut error = json!({
                "message": self.message,
                "type": self.error_type,
        });
        if let Some(upstream) = &self.upstream {
            error["code"] = json!(upstream.code);
            error["retryable"] = json!(upstream.retryable);
        }
        let mut response = (self.status, Json(json!({"error": error}))).into_response();
        if let Some(value) = self.upstream.and_then(|upstream| upstream.retry_after) {
            response
                .headers_mut()
                .insert(axum::http::header::RETRY_AFTER, value);
        }
        response
    }
}

fn extract_prompt(payload: &Value) -> Result<String> {
    if let Some(prompt) = payload
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(prompt.to_string());
    }

    if let Some(text) = payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(text.to_string());
    }

    if let Some(input) = payload.get("input").and_then(Value::as_array) {
        let collected = collect_from_items(input);
        if !collected.is_empty() {
            return Ok(collected.join("\n\n"));
        }
    }

    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        let collected = messages
            .iter()
            .filter(|message| {
                message
                    .get("role")
                    .and_then(Value::as_str)
                    .map(|role| matches!(role, "user" | "system"))
                    .unwrap_or(false)
            })
            .flat_map(|message| match message.get("content") {
                Some(Value::String(s)) => vec![s.trim().to_string()],
                Some(Value::Array(parts)) => collect_from_items(parts),
                _ => Vec::new(),
            })
            .collect::<Vec<_>>();

        if !collected.is_empty() {
            return Ok(collected.join("\n\n"));
        }
    }

    Err(anyhow!("request is missing prompt content"))
}

fn parse_chat_completion_inputs(payload: &Value) -> Result<Vec<Value>> {
    let messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("request is missing messages array"))?;

    let (instruction_segments, mut input_items, saw_user) =
        convert_chat_messages_to_input(messages);

    if !saw_user {
        return Err(anyhow!(
            "request must include at least one user message with text content"
        ));
    }

    apply_instruction_overrides(payload, instruction_segments, &mut input_items);

    if input_items.is_empty() {
        return Err(anyhow!("request must include valid message content"));
    }

    Ok(input_items)
}

fn extract_message_text(message: &Value) -> Option<String> {
    match message.get("content") {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Array(parts)) => {
            let collected = collect_from_items(parts);
            if collected.is_empty() {
                None
            } else {
                Some(collected.join("\n\n"))
            }
        }
        _ => None,
    }
}

fn collect_from_items(items: &[Value]) -> Vec<String> {
    let mut collected = Vec::new();

    for item in items {
        match item {
            Value::String(s) => {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    collected.push(trimmed.to_string());
                }
            }
            Value::Object(map) => {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        collected.push(trimmed.to_string());
                        continue;
                    }
                }

                if let Some(content) = map.get("content") {
                    match content {
                        Value::String(s) => {
                            let trimmed = s.trim();
                            if !trimmed.is_empty() {
                                collected.push(trimmed.to_string());
                            }
                        }
                        Value::Array(parts) => {
                            collected.extend(collect_from_items(parts));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    collected
}

fn convert_chat_messages_to_input(messages: &[Value]) -> (Vec<String>, Vec<Value>, bool) {
    let mut instruction_segments: Vec<String> = Vec::new();
    let mut input_items: Vec<Value> = Vec::new();
    let mut saw_user = false;

    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");

        match role {
            "system" | "developer" => {
                if let Some(text) = extract_message_text(message) {
                    instruction_segments.push(text);
                }
            }
            "tool" => {
                if let Some(item) = convert_tool_message(message) {
                    input_items.push(item);
                }
            }
            "assistant" => {
                if let Some(item) = build_message_item(message, "assistant") {
                    input_items.push(item);
                }
                if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for tool_call in tool_calls {
                        if let Some(call_item) = convert_tool_call(tool_call) {
                            input_items.push(call_item);
                        }
                    }
                }
            }
            _ => {
                if let Some(item) = build_message_item(message, "user") {
                    saw_user = true;
                    input_items.push(item);
                }
            }
        }
    }

    (instruction_segments, input_items, saw_user)
}

fn build_message_item(message: &Value, role: &str) -> Option<Value> {
    let content_items = collect_message_content(message, role);
    if content_items.is_empty() {
        return None;
    }

    let role_out = if role == "assistant" {
        "assistant"
    } else {
        "user"
    };

    Some(json!({
        "type": "message",
        "role": role_out,
        "content": content_items,
    }))
}

fn collect_message_content(message: &Value, role: &str) -> Vec<Value> {
    match message.get("content") {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                let kind = if role == "assistant" {
                    "output_text"
                } else {
                    "input_text"
                };
                vec![json!({
                    "type": kind,
                    "text": trimmed,
                })]
            }
        }
        Some(Value::Array(parts)) => {
            let mut collected = Vec::new();
            for part in parts {
                if let Some(obj) = part.as_object() {
                    let part_type = obj
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    match part_type.as_str() {
                        "text" | "input_text" | "output_text" => {
                            if let Some(text) = obj
                                .get("text")
                                .or_else(|| obj.get("content"))
                                .and_then(Value::as_str)
                            {
                                let trimmed = text.trim();
                                if !trimmed.is_empty() {
                                    let kind = if role == "assistant" {
                                        "output_text"
                                    } else {
                                        "input_text"
                                    };
                                    collected.push(json!({
                                        "type": kind,
                                        "text": trimmed,
                                    }));
                                }
                            }
                        }
                        "image_url" => {
                            if let Some(url) = obj
                                .get("image_url")
                                .and_then(|v| v.get("url"))
                                .and_then(Value::as_str)
                            {
                                collected.push(json!({
                                    "type": "input_image",
                                    "image_url": url,
                                }));
                            }
                        }
                        "input_image" => {
                            collected.push(Value::Object(obj.clone()));
                        }
                        _ => {
                            if let Some(text) = obj.get("text").and_then(Value::as_str) {
                                let trimmed = text.trim();
                                if !trimmed.is_empty() {
                                    let kind = if role == "assistant" {
                                        "output_text"
                                    } else {
                                        "input_text"
                                    };
                                    collected.push(json!({
                                        "type": kind,
                                        "text": trimmed,
                                    }));
                                }
                            }
                        }
                    }
                } else if let Some(text) = part.as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        let kind = if role == "assistant" {
                            "output_text"
                        } else {
                            "input_text"
                        };
                        collected.push(json!({
                            "type": kind,
                            "text": trimmed,
                        }));
                    }
                }
            }
            collected
        }
        _ => Vec::new(),
    }
}

fn convert_tool_call(tool_call: &Value) -> Option<Value> {
    let call_id = tool_call
        .get("id")
        .or_else(|| tool_call.get("call_id"))
        .and_then(Value::as_str)
        .map(str::to_string)?;

    let function = tool_call.get("function")?.as_object()?;
    let name = function.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }

    let args_value = function.get("arguments");
    let arguments = match args_value {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(value) => serde_json::to_string(value).ok()?,
        None => "{}".to_string(),
    };

    Some(json!({
        "type": "function_call",
        "name": name,
        "arguments": arguments,
        "call_id": call_id,
    }))
}

fn convert_tool_message(message: &Value) -> Option<Value> {
    let call_id = message
        .get("tool_call_id")
        .or_else(|| message.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)?;

    let output_segments = match message.get("content") {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        Some(Value::Array(parts)) => collect_from_items(parts),
        _ => Vec::new(),
    };

    if output_segments.is_empty() {
        return None;
    }

    Some(json!({
        "type": "function_call_output",
        "call_id": call_id,
        "output": output_segments.join("\n"),
    }))
}

fn build_user_message_from_text(text: &str) -> Value {
    let trimmed = text.trim();
    json!({
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": trimmed,
            }
        ],
    })
}

fn apply_instruction_overrides(
    payload: &Value,
    mut instruction_segments: Vec<String>,
    items: &mut Vec<Value>,
) {
    if let Some(extra) = payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        instruction_segments.push(extra.to_string());
    }

    if instruction_segments.is_empty() {
        return;
    }

    let combined = instruction_segments.join("\n\n");
    if combined.trim().is_empty() {
        return;
    }

    items.insert(0, build_user_message_from_text(&combined));
}

fn split_input_instruction_messages(input_items: &[Value]) -> (Vec<String>, Vec<Value>) {
    let mut instruction_segments: Vec<String> = Vec::new();
    let mut normalized_items: Vec<Value> = Vec::new();

    for item in input_items {
        let is_message = item
            .get("type")
            .and_then(Value::as_str)
            .map(|item_type| item_type.eq_ignore_ascii_case("message"))
            .unwrap_or(false);
        if is_message {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("");
            if role.eq_ignore_ascii_case("system") || role.eq_ignore_ascii_case("developer") {
                if let Some(text) = extract_message_text(item) {
                    instruction_segments.push(text);
                }
                continue;
            }
        }

        normalized_items.push(item.clone());
    }

    (instruction_segments, normalized_items)
}

fn extract_input_items(payload: &Value) -> Result<Vec<Value>> {
    if let Some(input_array) = payload.get("input").and_then(Value::as_array) {
        let object_items = input_array
            .iter()
            .filter(|value| value.is_object())
            .cloned()
            .collect::<Vec<_>>();
        if !object_items.is_empty() {
            let (instruction_segments, mut items) = split_input_instruction_messages(&object_items);
            apply_instruction_overrides(payload, instruction_segments, &mut items);
            return Ok(items);
        }
    }

    if let Some(obj) = payload.get("input").and_then(Value::as_object) {
        let item = Value::Object(obj.clone());
        let (instruction_segments, mut items) =
            split_input_instruction_messages(std::slice::from_ref(&item));
        apply_instruction_overrides(payload, instruction_segments, &mut items);
        if !items.is_empty() {
            return Ok(items);
        }
    }

    if let Some(text) = payload
        .get("input")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let mut items = vec![build_user_message_from_text(text)];
        apply_instruction_overrides(payload, Vec::new(), &mut items);
        return Ok(items);
    }

    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        let (instruction_segments, mut input_items, saw_user) =
            convert_chat_messages_to_input(messages);
        if saw_user && !input_items.is_empty() {
            apply_instruction_overrides(payload, instruction_segments, &mut input_items);
            return Ok(input_items);
        }
    }

    let prompt = extract_prompt(payload)?;
    let mut items = vec![build_user_message_from_text(&prompt)];
    apply_instruction_overrides(payload, Vec::new(), &mut items);
    Ok(items)
}

fn translate_usage(raw: &Value) -> Value {
    let usage = raw.get("usage").and_then(Value::as_object);

    if let Some(usage) = usage {
        let prompt_tokens = usage
            .get("input_tokens")
            .and_then(number_to_u64)
            .unwrap_or(0);
        let completion_tokens = usage
            .get("output_tokens")
            .and_then(number_to_u64)
            .unwrap_or(0);
        let total_tokens = usage
            .get("total_tokens")
            .and_then(number_to_u64)
            .unwrap_or(prompt_tokens + completion_tokens);

        json!({
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        })
    } else {
        json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        })
    }
}

fn number_to_u64(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return Some(n);
    }
    if let Some(n) = value.as_i64() {
        if n >= 0 {
            return Some(n as u64);
        }
    }
    if let Some(n) = value.as_f64() {
        if n >= 0.0 {
            return Some(n as u64);
        }
    }
    None
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        eprintln!("failed to listen for shutdown signal: {}", err);
    }
}

#[cfg(test)]
mod audio_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_chat_completion_with_history() {
        let payload = json!({
            "messages": [
                {"role": "system", "content": "Be helpful."},
                {"role": "assistant", "content": "Hello!"},
                {"role": "user", "content": "How are you?"}
            ]
        });

        let input_items = parse_chat_completion_inputs(&payload).unwrap();
        assert_eq!(input_items.len(), 3);
        assert_eq!(input_items[0]["role"], json!("user"));
        assert!(
            input_items[0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Be helpful."),
            "expected embedded instructions to include system guidance"
        );
        assert_eq!(input_items[1]["role"], json!("assistant"));
        assert_eq!(input_items[2]["role"], json!("user"));
        assert_eq!(
            input_items[2]["content"][0]["text"],
            json!("How are you?"),
            "expected user message text to be preserved"
        );
    }

    #[test]
    fn parse_chat_completion_handles_tool_calls() {
        let payload = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "search",
                                "arguments": "{\"query\":\"rust\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": "Found results"
                },
                {"role": "user", "content": "Thanks!"}
            ]
        });

        let input_items = parse_chat_completion_inputs(&payload).unwrap();

        assert_eq!(input_items.len(), 3);
        assert_eq!(input_items[0]["type"], json!("function_call"));
        assert_eq!(input_items[1]["type"], json!("function_call_output"));
        assert_eq!(input_items[2]["role"], json!("user"));
    }

    #[test]
    fn extract_input_items_from_prompt_fallback() {
        let payload = json!({
            "prompt": "Say hello"
        });

        let items = extract_input_items(&payload).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["role"], json!("user"));
        assert_eq!(items[0]["content"][0]["text"], json!("Say hello"));
    }

    #[test]
    fn extract_input_items_strips_developer_messages_from_input_array() {
        let payload = json!({
            "input": [
                {
                    "type": "message",
                    "role": "developer",
                    "content": [
                        { "type": "input_text", "text": "Always explain your steps." }
                    ]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Generate a simple React app." }
                    ]
                }
            ]
        });

        let items = extract_input_items(&payload).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["role"], json!("user"));
        assert_eq!(items[1]["role"], json!("user"));
        assert_eq!(
            items[0]["content"][0]["text"],
            json!("Always explain your steps.")
        );
        assert_eq!(
            items[1]["content"][0]["text"],
            json!("Generate a simple React app.")
        );
        assert!(
            items
                .iter()
                .all(|item| item.get("role").and_then(Value::as_str) != Some("developer"))
        );
    }

    #[test]
    fn translate_usage_converts_counts() {
        let raw = json!({
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "total_tokens": 16
            }
        });

        let usage = translate_usage(&raw);
        assert_eq!(usage["prompt_tokens"], json!(10));
        assert_eq!(usage["completion_tokens"], json!(5));
        assert_eq!(usage["total_tokens"], json!(16));
    }

    #[test]
    fn requested_reasoning_effort_preserves_runtime_turn_setting() {
        for effort in ["minimal", "low", "medium", "high", "xhigh", "max"] {
            let payload = json!({
                "model": "gpt-6-astra",
                "reasoning": {
                    "effort": format!(" {} ", effort.to_ascii_uppercase()),
                    "summary": "auto"
                }
            });
            assert_eq!(
                requested_reasoning_effort(&payload).as_deref(),
                Some(effort)
            );
        }
    }

    #[test]
    fn requested_reasoning_effort_ignores_invalid_values() {
        for effort in [
            json!("lots"),
            json!(""),
            json!("ultra"),
            json!(4),
            json!(null),
        ] {
            assert_eq!(
                requested_reasoning_effort(&json!({"reasoning": {"effort": effort}})),
                None
            );
        }
        assert_eq!(requested_reasoning_effort(&json!({})), None);
    }

    #[test]
    fn resolve_model_for_credentials_prefers_default_for_byoc_openai_model_ids() {
        let creds = Credentials::ApiKey {
            key: "test".to_string(),
            endpoint: Some("https://api.deepseek.com/v1/chat/completions".to_string()),
            default_model: Some("deepseek-chat".to_string()),
        };

        assert_eq!(
            resolve_model_for_credentials("gpt-5-codex", &creds),
            "deepseek-chat"
        );
        assert_eq!(
            resolve_model_for_credentials("gpt-4.5", &creds),
            "deepseek-chat"
        );
        assert_eq!(
            resolve_model_for_credentials("o3-mini", &creds),
            "deepseek-chat"
        );
        assert_eq!(
            resolve_model_for_credentials("deepseek-chat", &creds),
            "deepseek-chat"
        );
        assert_eq!(
            resolve_model_for_credentials("glm-4.5", &creds),
            "deepseek-chat"
        );
    }

    #[test]
    fn resolve_model_for_credentials_can_infer_default_for_known_byoc_endpoints() {
        let creds = Credentials::ApiKey {
            key: "test".to_string(),
            endpoint: Some("https://api.z.ai/api/coding/paas/v4/chat/completions".to_string()),
            default_model: None,
        };

        assert_eq!(
            resolve_model_for_credentials("gpt-5-codex", &creds),
            "glm-5"
        );
        assert_eq!(
            resolve_model_for_credentials("deepseek-chat", &creds),
            "glm-5"
        );
    }

    #[test]
    fn resolve_model_for_chatgpt_uses_default_for_non_chatgpt_models() {
        let creds = Credentials::ChatGpt {
            access_token: "test".to_string(),
            refresh_token: None,
            account_id: None,
            default_model: Some("gpt-5.5".to_string()),
            auth_path: None,
        };

        assert_eq!(resolve_model_for_credentials("glm-4.5", &creds), "gpt-5.5");
        assert_eq!(
            resolve_model_for_credentials("deepseek-chat", &creds),
            "gpt-5.5"
        );
        assert_eq!(
            resolve_model_for_credentials("gemini-2.5-pro", &creds),
            "gpt-5.5"
        );
        assert_eq!(resolve_model_for_credentials("gpt-5.5", &creds), "gpt-5.5");
    }

    #[test]
    fn resolve_model_honors_explicit_model_over_credential_default() {
        // Issue #116: DEFAULT_MODEL used to double as a "use the credential
        // default" sentinel, so an explicit pick of that id was silently
        // rewritten to the credential default (gpt-5.6-sol in production).
        let creds = Credentials::ChatGpt {
            access_token: "test".to_string(),
            refresh_token: None,
            account_id: None,
            default_model: Some("gpt-5.6-sol".to_string()),
            auth_path: None,
        };

        assert_eq!(resolve_model_for_credentials("gpt-5.5", &creds), "gpt-5.5");
        assert_eq!(
            resolve_model_for_credentials("gpt-5.6-sol", &creds),
            "gpt-5.6-sol"
        );
        assert_eq!(
            resolve_model_for_credentials("gpt-5.5-mini", &creds),
            "gpt-5.5-mini"
        );
    }

    #[test]
    fn resolve_model_uses_credential_default_only_when_model_absent() {
        let creds = Credentials::ChatGpt {
            access_token: "test".to_string(),
            refresh_token: None,
            account_id: None,
            default_model: Some("gpt-5.6-sol".to_string()),
            auth_path: None,
        };

        assert_eq!(resolve_model_for_credentials("", &creds), "gpt-5.6-sol");
        assert_eq!(resolve_model_for_credentials("   ", &creds), "gpt-5.6-sol");
    }

    #[test]
    fn resolve_model_falls_back_to_crate_default_without_credential_default() {
        let creds = Credentials::ApiKey {
            key: "test".to_string(),
            endpoint: Some("https://api.openai.com/v1/responses".to_string()),
            default_model: None,
        };

        assert_eq!(resolve_model_for_credentials("", &creds), DEFAULT_MODEL);
        assert_eq!(
            resolve_model_for_credentials("gpt-5.6-sol", &creds),
            "gpt-5.6-sol"
        );
    }

    #[test]
    fn upstream_error_marks_controller_credential_lease_renewal_failure_terminal() {
        let error = AppError::upstream(
            anyhow!("private controller failure detail")
                .context(UpstreamFailure::CredentialRefresh),
        );

        assert_eq!(error.status, StatusCode::FAILED_DEPENDENCY);
        assert_eq!(error.error_type, "upstream_error");
        assert_eq!(
            error.upstream.unwrap().code,
            "upstream_credential_refresh_failed"
        );
        assert!(!error.message.contains("private controller failure detail"));
    }

    /// A controller-signed token with the given `run_id` and `credential_id`
    /// claims and nothing else set.
    fn controller_claims(run_id: Option<&str>, credential_id: Option<&str>) -> ProxyClaims {
        ProxyClaims {
            _aud: None,
            _iss: None,
            project_id: "project".to_string(),
            runtime_id: None,
            run_id: run_id.map(str::to_string),
            credential_id: credential_id.map(str::to_string),
            agent_handle: None,
            agent_display_name: None,
            agent_description: None,
            exp: None,
        }
    }

    const BYOC_REJECTION: &str = "proxy token missing credential_id for BYOC request";

    #[test]
    fn managed_ai_credential_id_matches_the_controller_literal() {
        // The controller answers exactly this id from MANAGED_AI_OPENAI_API_KEY
        // (runtime-controller::config::MANAGED_AI_CREDENTIAL_ID). Editing
        // either constant alone must fail a suite.
        assert_eq!(
            MANAGED_AI_CREDENTIAL_ID,
            "4d414e41-4745-4441-8949-4e5354414659"
        );
        assert!(Uuid::parse_str(MANAGED_AI_CREDENTIAL_ID).is_ok());
    }

    #[test]
    fn dynamic_lease_target_leases_the_claimed_credential_first() {
        // A BYOC token leases its own id whether or not it carries a run_id.
        let claims = controller_claims(Some("run-1"), Some("cred-1"));
        assert_eq!(
            dynamic_lease_target(Some(&claims)).expect("claimed credential"),
            ("cred-1", "claim")
        );
        let claims = controller_claims(None, Some("cred-1"));
        assert_eq!(
            dynamic_lease_target(Some(&claims)).expect("claimed credential"),
            ("cred-1", "claim")
        );
    }

    #[test]
    fn dynamic_lease_target_falls_back_to_the_managed_credential_for_job_tokens() {
        // A dispatch job token: run_id set, no credential (the managed lane).
        let claims = controller_claims(Some("run-1"), None);
        assert_eq!(
            dynamic_lease_target(Some(&claims)).expect("managed fallback"),
            (MANAGED_AI_CREDENTIAL_ID, "managed")
        );
        // A blank credential_id is no credential.
        let claims = controller_claims(Some("run-1"), Some("   "));
        assert_eq!(
            dynamic_lease_target(Some(&claims)).expect("managed fallback"),
            (MANAGED_AI_CREDENTIAL_ID, "managed")
        );
    }

    #[test]
    fn dynamic_lease_target_rejects_credential_less_tokens_without_a_run_id() {
        // The agent-login and runtime-register envelopes: no run_id, no
        // credential. They must keep the exact pre-existing rejection and
        // never reach the managed lease.
        for claims in [
            controller_claims(None, None),
            controller_claims(Some("   "), None),
            controller_claims(None, Some("")),
        ] {
            let error = dynamic_lease_target(Some(&claims)).expect_err("no managed fallback");
            assert_eq!(error.status, StatusCode::UNAUTHORIZED);
            assert_eq!(error.message, BYOC_REJECTION);
        }
        // No claims at all (controller auth not required) is not a managed turn.
        let error = dynamic_lease_target(None).expect_err("no managed fallback");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, BYOC_REJECTION);
        assert!(credential_id_from_claims(None).is_none());
        assert!(run_id_from_claims(None).is_none());
    }

    #[test]
    fn proxy_auth_mode_is_managed_only_for_credential_less_tokens() {
        let mut claims = controller_claims(None, None);
        assert_eq!(proxy_auth_mode(None), "managed");
        assert_eq!(proxy_auth_mode(Some(&claims)), "managed");
        claims.credential_id = Some("   ".to_string());
        assert_eq!(proxy_auth_mode(Some(&claims)), "managed");
        claims.credential_id = Some("cred-1".to_string());
        assert_eq!(proxy_auth_mode(Some(&claims)), "byoc");
    }

    #[test]
    fn managed_lease_failure_keeps_the_byoc_rejection_prefix() {
        let error = dynamic_lease_error(
            "managed",
            anyhow!("controller credentials returned 404 Not Found"),
        );
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert!(
            error
                .message
                .starts_with("proxy token missing credential_id for BYOC request"),
            "unexpected message: {}",
            error.message
        );
        assert!(error.message.contains("404 Not Found"));

        let error = dynamic_lease_error("claim", anyhow!("controller credential lease failed"));
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "controller credential lease failed");
    }

    #[test]
    fn upstream_error_keeps_generic_failures_as_bad_gateway() {
        let error = AppError::upstream(anyhow!(
            "upstream request failed: failed to send request to model provider"
        ));

        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert_eq!(error.error_type, "upstream_error");
    }
}
