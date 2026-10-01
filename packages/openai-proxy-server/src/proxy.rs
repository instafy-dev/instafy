use std::borrow::Cow;
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
use serde_json::{Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::auth::{Credentials, response_indicates_chatgpt_token_expired};
use crate::client::{
    CodexClient, CodexCompletion, DEFAULT_INSTRUCTIONS, DEFAULT_MODEL,
    RequiredToolCallFallbackHook, SendHook, ServiceTierEndpoints, conversation_id_enabled,
    is_additional_tools_item, normalize_reasoning_effort, sends_service_tier, sends_tool_controls,
};
use crate::controller_integration::ControllerIntegration;
use crate::credential_lease::LeasedCredentials;
use crate::incomplete_response;
use crate::proxy_auth::ProxyClaims;
use crate::upstream_error::{self, ToolControlRejection, UpstreamFailure};

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
    RemoteStatic(StaticCredentials),
    RemoteDynamic,
}

/// The credentials the proxy started with (`OPENAI_API_KEY` or `auth.json`).
/// They serve the platform lane and, on a proxy without a controller, every
/// request, so they are the operator's key just like the controller's managed
/// lease.
#[derive(Clone)]
struct StaticCredentials {
    credentials: Credentials,
    /// `PROXY_PINNED_MODEL`: the only model managed runs on these credentials
    /// may use, the static counterpart of the managed lease's `pinnedModel`.
    pinned_model: Option<String>,
    /// Warnings logged because a managed run was served without
    /// `PROXY_PINNED_MODEL`: at most one, and the proxy builds one backend per
    /// process.
    unpinned_managed_run_warnings: Arc<AtomicUsize>,
}

impl StaticCredentials {
    fn new(credentials: Credentials, pinned_model: Option<String>) -> Self {
        Self {
            credentials,
            pinned_model: pinned_model
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            unpinned_managed_run_warnings: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// The static credentials for a proxy without a controller, which checks
    /// no token: every request keeps the model it asks for.
    fn unauthenticated_lease(&self) -> LeasedCredentials {
        LeasedCredentials::unpinned(self.credentials.clone())
    }

    /// The static credentials for a platform-lane request, a managed run: it
    /// gets the managed lease's pinned-lease policy, pinned to
    /// `PROXY_PINNED_MODEL`, which also refuses audio and drops hosted and
    /// model-naming client tools. Without the setting the lease is unpinned
    /// and none of that applies.
    fn platform_lease(&self) -> LeasedCredentials {
        if self.pinned_model.is_none()
            && self
                .unpinned_managed_run_warnings
                .compare_exchange(0, 1, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            eprintln!(
                "[proxy] static proxy credentials are serving a managed run but the managed model is not pinned: managed runs keep the model they ask for and every client tool, hosted ones such as web search included, and speech and transcription stay available, on these credentials. Set PROXY_PINNED_MODEL to MANAGED_AI_MODEL_ID to pin them."
            );
        }
        LeasedCredentials {
            credentials: self.credentials.clone(),
            pinned_model: self.pinned_model.clone(),
        }
    }

    /// `staticCredentialKind` in the platform lane report.
    fn kind(&self) -> &'static str {
        match self.credentials {
            Credentials::ApiKey { .. } => "api_key",
            Credentials::ChatGpt { .. } => "chatgpt",
            Credentials::GeminiCodeAssist { .. } => "gemini_code_assist",
        }
    }
}

#[derive(Clone)]
struct ProxyState {
    backend: ProxyBackend,
    controller: Option<ControllerIntegration>,
    require_controller_auth: bool,
    require_credential_claim: bool,
    /// Platform-lane model requests the proxy sent upstream without the
    /// `service_tier` they asked for since it started. Handlers get a clone
    /// of the state, so the count is shared.
    service_tier_overrides: Arc<AtomicU64>,
    /// `PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS`: which upstream endpoints the
    /// platform lane's tier goes to.
    service_tier_endpoints: ServiceTierEndpoints,
    /// Requests on any lane that the proxy sent upstream again without the
    /// `tool_choice: "required"` it set, after upstream refused that choice,
    /// since it started. Shared by every clone of the state, as above.
    required_tool_call_fallbacks: Arc<AtomicU64>,
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

/// The model one upstream request is sent as. A lease the controller pinned
/// (the managed lane, where the operator pays) goes out as its pinned model
/// whatever the request names: the controller sets the runtime's CODEX_MODEL
/// to the managed model for every credential-less AI job, and the pin covers
/// a job whose secrets fetch failed and any client that ignores that env, so
/// neither can ask for the runtime default on the platform key.
/// Without a pin the credential rules below apply unchanged.
fn resolve_model_for_lease(requested_model: &str, leased: &LeasedCredentials) -> String {
    match leased.pinned_model() {
        Some(pinned_model) => pinned_model.to_string(),
        None => resolve_model_for_credentials(requested_model, &leased.credentials),
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

/// The client tool types a pinned lease forwards: the types codex, the
/// runtime's client at the revision this repository pins, puts in `tools`
/// (its `ToolSpec`, `codex-rs/tools/src/tool_spec.rs`), less the hosted ones
/// in [`PINNED_LEASE_DROPPED_TOOL_TYPES`]. A hosted tool codex never sends,
/// such as `image_generation`, can run a model of its own or add a per-call
/// fee on the key the operator pays for.
const PINNED_LEASE_TOOL_TYPES: [&str; 4] = ["function", "custom", "namespace", "tool_search"];

/// Codex tool types that OpenAI runs on its side, billed per call on top of
/// tokens. A pinned lease drops them on purpose: credits price tokens only.
/// The pin, not the lane, decides it. Only the platform lane is ever pinned
/// (the controller's managed lease, static credentials with
/// `PROXY_PINNED_MODEL`), and an unpinned lease keeps them: a user's own
/// credential, and the platform lane before the pin reaches it.
const PINNED_LEASE_DROPPED_TOOL_TYPES: [&str; 1] = ["web_search"];

/// Why a pinned lease drops a client tool, or `None` to forward it: its type
/// must be one codex emits and not a hosted one, a tool search must run on
/// the client, it must name no model of its own, and a namespace passes only
/// when every tool it groups does.
fn pinned_lease_tool_rejection(tool: &Value) -> Option<&'static str> {
    let Some(tool) = tool.as_object() else {
        return Some("type");
    };
    let tool_type = tool.get("type").and_then(Value::as_str).unwrap_or_default();
    if PINNED_LEASE_DROPPED_TOOL_TYPES.contains(&tool_type) {
        return Some("hosted");
    }
    if !PINNED_LEASE_TOOL_TYPES.contains(&tool_type) {
        return Some("type");
    }
    // Codex runs its tool search itself (`execution: "client"`); any other
    // execution asks OpenAI to run the search.
    if tool_type == "tool_search" && tool.get("execution").and_then(Value::as_str) != Some("client")
    {
        return Some("hosted");
    }
    if tool.contains_key("model") {
        return Some("model");
    }
    if tool
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|members| {
            members
                .iter()
                .any(|member| pinned_lease_tool_rejection(member).is_some())
        })
    {
        return Some("member");
    }
    None
}

/// A client tool a pinned lease did not forward, as logged.
#[derive(Debug)]
struct DroppedTool {
    /// Where the request carried it: `tools`, or the input item type.
    carrier: &'static str,
    tool_type: String,
    reason: &'static str,
}

/// The client tools a pinned lease forwards, plus each one it drops.
fn tools_for_pinned_lease(
    tools: &[Value],
    carrier: &'static str,
) -> (Vec<Value>, Vec<DroppedTool>) {
    let mut kept = Vec::with_capacity(tools.len());
    let mut dropped = Vec::new();
    for tool in tools {
        match pinned_lease_tool_rejection(tool) {
            None => kept.push(tool.clone()),
            Some(reason) => dropped.push(DroppedTool {
                carrier,
                // Client text, so bounded; a tool entry carries no credential.
                tool_type: tool
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .chars()
                    .take(64)
                    .collect(),
                reason,
            }),
        }
    }
    (kept, dropped)
}

/// Most distinct (carrier, type, reason) groups one drop summary names.
const MAX_LOGGED_DROP_GROUPS: usize = 8;

/// One log record per filter pass over the tools a request lost to the pin:
/// counts per (carrier, type, reason), the largest groups first. The client's
/// tools and the proxy's own default tools are filtered in separate passes, so
/// a request can log two records. A request can carry millions of tool
/// entries, so each record is bounded however many it drops.
fn dropped_tools_summary(dropped: &[DroppedTool]) -> Value {
    let mut counts: BTreeMap<(&str, &str, &str), usize> = BTreeMap::new();
    for tool in dropped {
        *counts
            .entry((tool.carrier, tool.tool_type.as_str(), tool.reason))
            .or_default() += 1;
    }
    let group_count = counts.len();
    let mut groups: Vec<_> = counts.into_iter().collect();
    // Stable, so equal counts keep the map's deterministic order.
    groups.sort_by(|left, right| right.1.cmp(&left.1));
    json!({
        "total": dropped.len(),
        "groups": groups
            .into_iter()
            .take(MAX_LOGGED_DROP_GROUPS)
            .map(|((carrier, tool_type, reason), count)| json!({
                "carrier": carrier,
                "toolType": tool_type,
                "reason": reason,
                "count": count,
            }))
            .collect::<Vec<_>>(),
        "otherGroups": group_count.saturating_sub(MAX_LOGGED_DROP_GROUPS),
    })
}

fn log_dropped_tools(dropped: &[DroppedTool], run_id: Option<&str>) {
    let mut summary = dropped_tools_summary(dropped);
    summary["runId"] = json!(run_id);
    eprintln!("[proxy] credential lease drops client tools {summary}");
}

/// Input item types that carry tool definitions. Codex sends its whole tool
/// list as an `additional_tools` item instead of `tools` when the model uses
/// Responses Lite, as the managed model does, and replays client tool search
/// results as `tool_search_output`.
const TOOL_CARRYING_INPUT_TYPES: [&str; 2] = ["additional_tools", "tool_search_output"];

/// The input a pinned lease forwards: the tools inside tool-carrying items
/// pass the same test as the request's `tools`. Borrowed unless one is
/// dropped.
fn input_items_for_pinned_lease(input_items: &[Value]) -> (Cow<'_, [Value]>, Vec<DroppedTool>) {
    let mut filtered: Option<Vec<Value>> = None;
    let mut dropped = Vec::new();
    for (index, item) in input_items.iter().enumerate() {
        let Some(carrier) = item
            .get("type")
            .and_then(Value::as_str)
            .and_then(|item_type| {
                TOOL_CARRYING_INPUT_TYPES
                    .into_iter()
                    .find(|carrier| *carrier == item_type)
            })
        else {
            continue;
        };
        let Some(tools) = item.get("tools").and_then(Value::as_array) else {
            continue;
        };
        let (kept, item_dropped) = tools_for_pinned_lease(tools, carrier);
        if item_dropped.is_empty() {
            continue;
        }
        dropped.extend(item_dropped);
        filtered.get_or_insert_with(|| input_items.to_vec())[index]["tools"] = Value::Array(kept);
    }
    (
        filtered.map_or(Cow::Borrowed(input_items), Cow::Owned),
        dropped,
    )
}

/// The `client_metadata` key the runtime's required execution gate sets to
/// `"1"` on a model request that must call a tool. The proxy builds the
/// upstream body itself and copies no `client_metadata` into it, so neither
/// this key nor the rest of the metadata goes upstream.
const REQUIRE_TOOL_CALL_METADATA_KEY: &str = "instafy.require_tool_call";

/// Whether the request's `client_metadata` asks for a required tool call:
/// [`REQUIRE_TOOL_CALL_METADATA_KEY`] set to exactly `"1"`. Any other value
/// is ignored.
fn require_tool_call_requested(payload: &Value) -> bool {
    payload
        .get("client_metadata")
        .and_then(|metadata| metadata.get(REQUIRE_TOOL_CALL_METADATA_KEY))
        .and_then(Value::as_str)
        == Some("1")
}

/// Whether a request that asked for a required tool call goes upstream with
/// `tool_choice: "required"`. It must go out on `credentials` with tool
/// controls ([`sends_tool_controls`]), so a Chat Completions or Gemini Code
/// Assist request never does. It must offer tools, in `tools` or in the
/// `additional_tools` input item where codex lists a Responses Lite model's
/// tools, and leave the choice to the model, with `tool_choice` `"auto"` or
/// absent. `tools` and `input_items` are the ones the request forwards, after
/// a pinned lease filters them, so a request left with no tools is never
/// told to call one. A request that did not ask keeps its tool controls as
/// they are: a Responses Lite request's own `tool_choice` is not forwarded.
fn required_tool_call_applies(
    requested: bool,
    credentials: &Credentials,
    tools_enabled: bool,
    tools: Option<&[Value]>,
    input_items: &[Value],
    tool_choice: Option<&Value>,
) -> bool {
    let offers_tools = tools.is_some_and(|tools| !tools.is_empty())
        || input_items.iter().any(|item| {
            is_additional_tools_item(item)
                && item
                    .get("tools")
                    .and_then(Value::as_array)
                    .is_some_and(|tools| !tools.is_empty())
        });
    let model_chooses = tool_choice.is_none_or(|choice| choice.as_str() == Some("auto"));
    requested && sends_tool_controls(credentials) && tools_enabled && offers_tools && model_chooses
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

/// Whose credential one request goes upstream on, from the token that
/// authenticated it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpstreamLane<'a> {
    /// The token names the user's own credential: leased from the controller
    /// by id, never pinned by the platform and never metered.
    Byo { credential_id: &'a str },
    /// A dispatch job token that names no credential, a managed run: the
    /// platform key. Its lease is the only one ever pinned, and the pinned
    /// lease policy (model, audio, client tools) follows that pin, not this
    /// lane, so an unpinned platform lease keeps the unpinned rules.
    Platform,
    /// The proxy has no controller integration, so it checked no token: its
    /// static credentials serve the request as they always have.
    Unauthenticated,
}

impl UpstreamLane<'_> {
    /// `provider.auth` in the instructions the proxy adds. A proxy without a
    /// controller serves its own static credentials, which it has always
    /// called managed.
    fn auth_mode(self) -> &'static str {
        match self {
            Self::Byo { .. } => "byoc",
            Self::Platform | Self::Unauthenticated => "managed",
        }
    }
}

/// The lane a request's claims put it on; `None` claims mean the proxy has no
/// controller integration.
///
/// The controller mints a credential-less token when the user has no
/// credential of their own (the managed lane) and serves the platform key
/// under [`MANAGED_AI_CREDENTIAL_ID`]. Only a dispatch job token is a managed
/// turn, and every dispatch job token carries a `run_id`
/// (`runtime-controller::agent::enqueue_agent_job_record` requires one;
/// `auth::issue_proxy_envelope` copies it into the claims). The controller
/// also mints credential-less tokens with no `run_id` at agent login and
/// runtime register; those are session envelopes, not turns, so both
/// backends refuse them with the pre-existing rejection and they never spend
/// the platform key, static credentials included.
/// `PROXY_REQUIRE_CREDENTIAL_CLAIM` rejects credential-less tokens during
/// authentication, so the public lane never reaches the platform lane.
///
/// [`MANAGED_AI_CREDENTIAL_ID`] is reserved for the platform lane: the proxy
/// leases it itself for a credential-less token, and no token names it as
/// its own credential, so one that does is refused.
fn classify_upstream_lane(claims: Option<&ProxyClaims>) -> Result<UpstreamLane<'_>, AppError> {
    if claims.is_none() {
        return Ok(UpstreamLane::Unauthenticated);
    }
    if let Some(credential_id) = credential_id_from_claims(claims) {
        if is_reserved_credential_id(credential_id) {
            return Err(AppError::unauthorized(anyhow!(
                "proxy token names a reserved credential"
            )));
        }
        return Ok(UpstreamLane::Byo { credential_id });
    }
    if run_id_from_claims(claims).is_some() {
        return Ok(UpstreamLane::Platform);
    }
    Err(AppError::unauthorized(anyhow!(
        "proxy token missing credential_id for BYOC request"
    )))
}

/// Whether `credential_id` is [`MANAGED_AI_CREDENTIAL_ID`] in any spelling
/// the controller would parse as that id.
fn is_reserved_credential_id(credential_id: &str) -> bool {
    let reserved = Uuid::parse_str(MANAGED_AI_CREDENTIAL_ID).ok();
    reserved.is_some() && Uuid::parse_str(credential_id.trim()).ok() == reserved
}

/// The credentials one request goes upstream on.
struct LaneLease<'a> {
    leased: LeasedCredentials,
    /// The controller credential the lease came from, which a lease renewal
    /// asks for again and a usage report names; `None` for static
    /// credentials.
    controller_credential_id: Option<&'a str>,
    /// `claim`, `managed` or `static`: the `credential_source` in error
    /// context.
    source: &'static str,
}

/// The only `service_tier` the platform key serves. Managed AI pricing
/// (`runtime-controller::ai_metering::pricing`) charges the standard tier's
/// rates, and `priority` costs about twice as much per token.
const PLATFORM_SERVICE_TIER: &str = "default";

/// `error.code` of the 400 that refuses a tier on the platform lane.
const SERVICE_TIER_NOT_ALLOWED: &str = "service_tier_not_allowed";

/// Most characters of a requested tier that a refusal names or an override
/// logs.
const MAX_NAMED_SERVICE_TIER_CHARS: usize = 32;

/// The `service_tier` a request names; JSON `null` counts as none.
fn requested_service_tier(payload: &Value) -> Option<&Value> {
    payload.get("service_tier").filter(|tier| !tier.is_null())
}

/// The `service_tier` one model request (Responses or Chat Completions)
/// goes upstream with.
#[derive(Debug, PartialEq)]
struct ModelServiceTier<'p> {
    /// `default` on the platform lane, which the client sends only to an
    /// endpoint `PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS` names, by default
    /// the OpenAI API; `None` on every other lane, which sends no tier.
    upstream: Option<Value>,
    /// The tier a platform-lane request asked for when the lane overrides
    /// it: replaced with `default`, or dropped for credentials or an
    /// endpoint sent no tier.
    overridden: Option<&'p str>,
}

/// Holds a model request to the tier its lane serves.
///
/// The platform lane sends `default` whether the request names it, no tier
/// at all, or any other string: a request without one runs on the OpenAI
/// project's own default tier, which the project's settings decide, and
/// `auto` follows that default too. The client sends it only where
/// [`ServiceTierEndpoints`] says, by default to the OpenAI API alone, since
/// an OpenAI-compatible provider may reject the field or its value; any
/// other endpoint gets no tier, as before the platform lane sent one.
/// Another string (`priority`, which codex's Fast mode sends, `flex`,
/// `scale`, or any other) is overridden rather than refused, so a stray
/// codex setting never fails a managed turn; the hook from
/// [`ProxyState::service_tier_override_hook`] counts and logs it when the
/// request goes upstream. Codex never sends a tier that is not a string,
/// so one is refused before a lease or an upstream call. This follows the
/// lane, not the pin: the tier multiplies the price of whatever model runs
/// on the operator's key. A user's own credential and a proxy without a
/// controller send no tier, whatever the request asks, as the proxy always
/// has.
fn model_service_tier<'p>(
    lane: UpstreamLane<'_>,
    payload: &'p Value,
) -> Result<ModelServiceTier<'p>, AppError> {
    if lane != UpstreamLane::Platform {
        return Ok(ModelServiceTier {
            upstream: None,
            overridden: None,
        });
    }
    let overridden = match requested_service_tier(payload) {
        None => None,
        Some(Value::String(tier)) => (tier != PLATFORM_SERVICE_TIER).then_some(tier.as_str()),
        Some(tier) => return Err(service_tier_not_allowed(tier)),
    };
    Ok(ModelServiceTier {
        upstream: Some(json!(PLATFORM_SERVICE_TIER)),
        overridden,
    })
}

/// Refuses a platform-lane audio request that names any tier but
/// `default`. Speech and transcription forward the client's own body, so
/// the proxy would have to rewrite it to override a tier, a multipart form
/// included; codex sends audio no tier, so a refusal costs no managed turn.
fn refuse_audio_service_tier(
    lane: UpstreamLane<'_>,
    requested: Option<&Value>,
) -> Result<(), AppError> {
    match requested {
        Some(tier) if lane == UpstreamLane::Platform && tier != PLATFORM_SERVICE_TIER => {
            Err(service_tier_not_allowed(tier))
        }
        _ => Ok(()),
    }
}

/// The coded 400 for a tier the platform lane does not serve.
fn service_tier_not_allowed(tier: &Value) -> AppError {
    // A short string is named as sent; anything else is not echoed, so the
    // message stays bounded.
    let requested = match tier {
        Value::String(tier) if tier.chars().count() <= MAX_NAMED_SERVICE_TIER_CHARS => {
            format!("{tier:?}")
        }
        _ => "of this request".to_string(),
    };
    AppError::bad_request_with_code(
        SERVICE_TIER_NOT_ALLOWED,
        anyhow!(
            "service_tier {requested} is not available on this credential: the platform key serves only the default tier, so send \"default\" or no service_tier"
        ),
    )
}

/// The log record of a model request's overridden tier on `credentials`,
/// `None` when nothing was overridden. `serviceTier` is the tier the
/// request goes upstream with: `default` to an endpoint `endpoints` names,
/// by default the OpenAI API, and `null` for any other endpoint, a ChatGPT
/// login or Gemini Code Assist, which are sent none, so the requested tier
/// is dropped. It names at most the first [`MAX_NAMED_SERVICE_TIER_CHARS`]
/// characters of the tier as requested, never the request body, so a
/// request cannot grow the log line.
fn service_tier_override_record(
    tier: &ModelServiceTier<'_>,
    credentials: &Credentials,
    endpoints: ServiceTierEndpoints,
    route: &str,
    run_id: Option<&str>,
) -> Option<Value> {
    let requested = tier.overridden?;
    let named = requested
        .chars()
        .take(MAX_NAMED_SERVICE_TIER_CHARS)
        .collect::<String>();
    let sent = tier
        .upstream
        .as_ref()
        .filter(|_| sends_service_tier(credentials, endpoints));
    Some(json!({
        "requestedServiceTier": named,
        "truncated": named.len() < requested.len(),
        "serviceTier": sent,
        "route": route,
        "runId": run_id,
    }))
}

/// A failed managed lease keeps today's rejection text as its prefix (a
/// controller without `MANAGED_AI_OPENAI_API_KEY` answers 404) and appends the
/// cause so an operator can tell the two apart.
fn managed_lease_error(error: anyhow::Error) -> AppError {
    AppError::unauthorized(anyhow!(
        "proxy token missing credential_id for BYOC request; managed AI credential lease failed: {error:#}"
    ))
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
    // The proxy used to debit this many credits per request; that flat burn is
    // gone, so an environment that still sets it gets one startup warning.
    if std::env::var("PROXY_CREDIT_BURN_AMOUNT").is_ok_and(|value| !value.trim().is_empty()) {
        eprintln!(
            "[proxy] PROXY_CREDIT_BURN_AMOUNT is ignored: the proxy no longer debits credits per request"
        );
    }
    let require_controller_auth = boolean_env("PROXY_REQUIRE_CONTROLLER_AUTH")?;
    let require_credential_claim = boolean_env("PROXY_REQUIRE_CREDENTIAL_CLAIM")?;
    let service_tier_endpoints =
        ServiceTierEndpoints::parse(std::env::var(ServiceTierEndpoints::ENV).ok().as_deref())?;
    let controller = ControllerIntegration::from_env()?;
    if (require_controller_auth || require_credential_claim) && controller.is_none() {
        anyhow::bail!(
            "PROXY_REQUIRE_CONTROLLER_AUTH/PROXY_REQUIRE_CREDENTIAL_CLAIM requires controller integration and proxy token validation"
        );
    }

    let backend = match credentials {
        // Only static credentials read the pin: a remote_dynamic proxy takes
        // it from the controller's managed lease.
        Some(creds) => ProxyBackend::RemoteStatic(StaticCredentials::new(
            creds,
            std::env::var("PROXY_PINNED_MODEL").ok(),
        )),
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
        service_tier_overrides: Arc::new(AtomicU64::new(0)),
        service_tier_endpoints,
        required_tool_call_fallbacks: Arc::new(AtomicU64::new(0)),
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
        "platformLane": state.platform_lane_report(),
        "requiredToolCallFallbacks": state.required_tool_call_fallbacks.load(Ordering::Relaxed),
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
        "platformLane": state.platform_lane_report(),
        "requiredToolCallFallbacks": state.required_tool_call_fallbacks.load(Ordering::Relaxed),
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

    /// The credentials a request on `lane` goes upstream on. A user's own
    /// credential is leased from the controller on either backend; the
    /// platform lane takes the static credentials when the proxy has them
    /// and the controller's managed lease otherwise.
    async fn lease_for_lane<'a>(&self, lane: UpstreamLane<'a>) -> Result<LaneLease<'a>, AppError> {
        match (&self.backend, lane) {
            (_, UpstreamLane::Byo { credential_id }) => Ok(LaneLease {
                leased: self
                    .require_controller()?
                    .acquire_credential_lease(credential_id)
                    .await
                    .and_then(|lease| lease.into_material())
                    .map_err(AppError::unauthorized)?,
                controller_credential_id: Some(credential_id),
                source: "claim",
            }),
            (ProxyBackend::RemoteStatic(static_creds), UpstreamLane::Platform) => Ok(LaneLease {
                leased: static_creds.platform_lease(),
                controller_credential_id: None,
                source: "static",
            }),
            (ProxyBackend::RemoteStatic(static_creds), UpstreamLane::Unauthenticated) => {
                Ok(LaneLease {
                    leased: static_creds.unauthenticated_lease(),
                    controller_credential_id: None,
                    source: "static",
                })
            }
            (ProxyBackend::RemoteDynamic, UpstreamLane::Platform) => Ok(LaneLease {
                leased: self
                    .require_controller()?
                    .acquire_credential_lease(MANAGED_AI_CREDENTIAL_ID)
                    .await
                    .and_then(|lease| lease.into_material())
                    .map_err(managed_lease_error)?,
                controller_credential_id: Some(MANAGED_AI_CREDENTIAL_ID),
                source: "managed",
            }),
            // A dynamic proxy always has a controller, so it checks every
            // token and never sees this lane.
            (ProxyBackend::RemoteDynamic, UpstreamLane::Unauthenticated) => Err(
                AppError::unauthorized(anyhow!("proxy controller authentication is required")),
            ),
        }
    }

    fn require_controller(&self) -> Result<&ControllerIntegration, AppError> {
        self.controller.as_ref().ok_or_else(|| {
            AppError::unauthorized(anyhow!("proxy controller integration is not configured"))
        })
    }

    /// What counts in `serviceTierOverrides` and logs a model request's tier
    /// the platform lane overrides, from [`model_service_tier`], on
    /// `credentials`; `None` when nothing was overridden. The client runs it
    /// when the request goes upstream, so a request that fails before then
    /// (bad input, no credits, a failed lease, or an error inside the proxy
    /// after the lease) is neither counted nor logged. Only a request's
    /// first attempt carries it, so a lease renewal's retry does not count
    /// the request again.
    fn service_tier_override_hook(
        &self,
        tier: &ModelServiceTier<'_>,
        credentials: &Credentials,
        route: &str,
        claims: Option<&ProxyClaims>,
    ) -> Option<SendHook> {
        let record = service_tier_override_record(
            tier,
            credentials,
            self.service_tier_endpoints,
            route,
            run_id_from_claims(claims),
        )?;
        let overrides = self.service_tier_overrides.clone();
        Some(Box::new(move || {
            overrides.fetch_add(1, Ordering::Relaxed);
            eprintln!("[proxy] platform lane overrides the requested service tier {record}");
        }))
    }

    /// `platformLane` on `/healthz` and `/readyz`: how this proxy serves a
    /// managed run, which the controller reads to check its proxy.
    ///
    /// - `servedBy`: `refused` when `PROXY_REQUIRE_CREDENTIAL_CLAIM` turns
    ///   away credential-less tokens, else `static` for static credentials
    ///   and `controller_lease` for the controller's managed lease.
    /// - `pinnedModel`: the model static credentials serve managed runs as.
    ///   Only a controller-signed token marks a managed run, so a proxy
    ///   without a controller pins nothing; a managed lease brings its own
    ///   pin, reported as `null`.
    /// - `staticCredentialKind`: `api_key`, `chatgpt` or
    ///   `gemini_code_assist` when static credentials serve the lane.
    /// - `sessionTokensRefused`: credential-less tokens without a run id
    ///   are refused, which needs a controller to sign tokens.
    /// - `serviceTier`: the `service_tier` the platform lane's Responses and
    ///   Chat Completions requests carry upstream, by the client's own rule
    ///   ([`sends_service_tier`]): `default` when static credentials and
    ///   their endpoint would carry it, `null` for a ChatGPT login, Gemini
    ///   Code Assist, or an endpoint `PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS`
    ///   does not name, and `null` when the proxy serves no platform lane
    ///   (`refused`, or no controller). A controller lease names its
    ///   endpoint only per lease, so for it the report says what the
    ///   setting implies for the managed lease, the controller's OpenAI API
    ///   key: `default` unless the setting is `none`.
    /// - `serviceTierOverrides`: platform-lane model requests since start
    ///   that the proxy sent upstream without the string tier they asked
    ///   for (replaced with `default`, or dropped where no tier is sent);
    ///   it only grows, and stays 0 without a platform lane.
    /// - `reportsUsage`, `controllerMeteringProtocol`, `outputCeilingSource`:
    ///   the proxy reports no usage to the controller, reads no metering
    ///   protocol from it and sends no output ceiling upstream yet.
    fn platform_lane_report(&self) -> Value {
        let static_creds = match &self.backend {
            ProxyBackend::RemoteStatic(static_creds) if !self.require_credential_claim => {
                Some(static_creds)
            }
            _ => None,
        };
        let served_by = if self.require_credential_claim {
            "refused"
        } else if static_creds.is_some() {
            "static"
        } else {
            "controller_lease"
        };
        let pinned_model = static_creds
            .filter(|_| self.controller.is_some())
            .and_then(|static_creds| static_creds.pinned_model.as_deref());
        let sends_tier = if self.controller.is_none() || self.require_credential_claim {
            false
        } else if let Some(static_creds) = static_creds {
            sends_service_tier(&static_creds.credentials, self.service_tier_endpoints)
        } else {
            self.service_tier_endpoints != ServiceTierEndpoints::Never
        };
        let service_tier = sends_tier.then_some(PLATFORM_SERVICE_TIER);
        json!({
            "servedBy": served_by,
            "pinnedModel": pinned_model,
            "staticCredentialKind": static_creds.map(StaticCredentials::kind),
            "sessionTokensRefused": self.controller.is_some(),
            "serviceTier": service_tier,
            "serviceTierOverrides": self.service_tier_overrides.load(Ordering::Relaxed),
            "reportsUsage": false,
            "controllerMeteringProtocol": null,
            "outputCeilingSource": null,
        })
    }
}

struct RemoteResponseControls<'a> {
    reasoning_effort: Option<&'a str>,
    requested_tools: Option<&'a Vec<Value>>,
    requested_tool_choice: Option<&'a Value>,
    requested_parallel_tool_calls: Option<bool>,
    requested_text_controls: Option<&'a Value>,
    /// From [`require_tool_call_requested`]; [`required_tool_call_applies`]
    /// decides whether it changes the `tool_choice` sent.
    require_tool_call: bool,
}

struct RemoteCompletionOptions<'a> {
    /// The proxy route the request came in on, as logged.
    route: &'a str,
    requested_model: &'a str,
    payload: &'a Value,
    proxy_base_instructions: &'a str,
    claims: Option<&'a ProxyClaims>,
    auth_mode: &'a str,
    plain_text_completion: bool,
    response_controls: Option<RemoteResponseControls<'a>>,
    /// From [`model_service_tier`], decided once per request, so a lease
    /// renewal's retry sends the same tier.
    service_tier: Option<&'a Value>,
    /// Which upstream endpoints get `service_tier`, from [`ProxyState`].
    service_tier_endpoints: ServiceTierEndpoints,
    /// `requiredToolCallFallbacks`, from [`ProxyState`].
    required_tool_call_fallbacks: &'a Arc<AtomicU64>,
}

fn error_indicates_chatgpt_token_refreshable(error: &anyhow::Error) -> bool {
    upstream_error::refreshable_auth(error)
}

/// Which attempt at a request a client is built for, as far as its required
/// tool call goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequiredToolCallAttempt {
    /// The first attempt: it sends `tool_choice: "required"` where
    /// [`required_tool_call_applies`] and logs that it does.
    First,
    /// A lease renewal's retry after an attempt that kept `required`: it
    /// sends it again, and does not log it again.
    Renewal,
    /// A lease renewal's retry after upstream refused `required` and the
    /// first attempt fell back: it sends the tool controls the request would
    /// have without the key, as the fallback did.
    RenewalAfterFallback,
}

/// What the client of a request that goes upstream with the
/// `tool_choice: "required"` the proxy set runs if upstream refuses that
/// choice and it falls back: one `requiredToolCallFallbacks` and one log line
/// with the route, the run id, and the upstream error's code and `param`,
/// never its message or the request body.
fn required_tool_call_fallback_hook(
    route: &str,
    run_id: Option<&str>,
    fallbacks: Arc<AtomicU64>,
) -> RequiredToolCallFallbackHook {
    let route = route.to_string();
    let run_id = run_id.map(str::to_string);
    Box::new(move |rejection: &ToolControlRejection| {
        fallbacks.fetch_add(1, Ordering::Relaxed);
        eprintln!(
            "[proxy] required tool call falls back to the request's own tool choice {}",
            json!({
                "route": route,
                "runId": run_id,
                "upstreamErrorCode": rejection.code,
                "upstreamErrorParam": rejection.param,
            })
        );
    })
}

/// Also returns the input items to send, which a pinned lease may filter.
/// `log_lease_policy` is false when a lease renewal rebuilds the client for a
/// request that already logged what its pinned lease changed, and
/// `required_tool_call_attempt` says whether the request may still send, and
/// log, a required tool call.
fn build_remote_completion_client<'i>(
    leased: LeasedCredentials,
    options: &RemoteCompletionOptions<'_>,
    input_items: &'i [Value],
    log_lease_policy: bool,
    required_tool_call_attempt: RequiredToolCallAttempt,
) -> Result<(CodexClient, String, String, Cow<'i, [Value]>)> {
    let endpoint_for_error = format_endpoint_for_error(leased.credentials.endpoint());
    let upstream_model = resolve_model_for_lease(options.requested_model, &leased);
    let requested_model = options.requested_model.trim();
    let pinned = leased.pinned_model().is_some();
    if log_lease_policy
        && pinned
        && !requested_model.is_empty()
        && requested_model != upstream_model
    {
        eprintln!(
            "[proxy] credential lease pins the model {}",
            json!({
                "requestedModel": requested_model,
                "upstreamModel": upstream_model,
                "runId": run_id_from_claims(options.claims),
            })
        );
    }
    // Only the pinned model may run on a pinned lease, so a client tool that
    // brings its own model or hosted work does not go upstream, whether the
    // request lists it in `tools` or in a tool-carrying input item. The
    // client sends input items as given, so the filtered ones below are the
    // ones the provider sees.
    let mut dropped_tools = Vec::new();
    let requested_tools = options
        .response_controls
        .as_ref()
        .and_then(|controls| controls.requested_tools)
        .map(|tools| {
            if !pinned {
                return tools.clone();
            }
            let (kept, dropped) = tools_for_pinned_lease(tools, "tools");
            dropped_tools.extend(dropped);
            kept
        });
    let input_items = if pinned {
        let (kept, dropped) = input_items_for_pinned_lease(input_items);
        dropped_tools.extend(dropped);
        kept
    } else {
        Cow::Borrowed(input_items)
    };
    let run_id = run_id_from_claims(options.claims);
    if log_lease_policy && !dropped_tools.is_empty() {
        log_dropped_tools(&dropped_tools, run_id);
    }
    let creds = leased.credentials;
    // Decided before the client takes the credentials; logged once it exists.
    let required_tool_call = required_tool_call_attempt
        != RequiredToolCallAttempt::RenewalAfterFallback
        && options.response_controls.as_ref().is_some_and(|controls| {
            required_tool_call_applies(
                controls.require_tool_call,
                &creds,
                !options.plain_text_completion,
                requested_tools.as_deref(),
                &input_items,
                controls.requested_tool_choice,
            )
        });
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
        .with_tools_enabled(!options.plain_text_completion)
        .with_service_tier(
            options.service_tier.cloned(),
            options.service_tier_endpoints,
        );
    if pinned {
        // A ChatGPT login whose request keeps no tools gets the client's
        // default tools, web search among them with CODEX_ENABLE_WEB_SEARCH,
        // after the filter above, unless it is a Responses Lite request. The
        // pin runs again on the list the request finally carries; tools it
        // already kept pass unchanged.
        let run_id = run_id.map(str::to_string);
        client = client.with_tool_filter(move |tools| {
            let (kept, dropped) = tools_for_pinned_lease(tools, "tools");
            if log_lease_policy && !dropped.is_empty() {
                log_dropped_tools(&dropped, run_id.as_deref());
            }
            kept
        });
    }

    if required_tool_call && required_tool_call_attempt == RequiredToolCallAttempt::First {
        eprintln!(
            "[proxy] required tool call sends tool_choice required {}",
            json!({ "route": options.route, "runId": run_id })
        );
    }
    if let Some(controls) = options.response_controls.as_ref() {
        client = client
            .with_reasoning_effort(controls.reasoning_effort.map(str::to_string))
            .with_response_controls(
                requested_tools,
                controls.requested_tool_choice.cloned(),
                controls.requested_parallel_tool_calls,
                controls.requested_text_controls.cloned(),
            )
            .with_required_tool_call(required_tool_call)
            .with_required_tool_call_fallback(required_tool_call.then(|| {
                required_tool_call_fallback_hook(
                    options.route,
                    run_id,
                    options.required_tool_call_fallbacks.clone(),
                )
            }));
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

    Ok((client, upstream_model, endpoint_for_error, input_items))
}

/// `send_hook` runs when the first attempt goes upstream; a lease renewal's
/// retry follows an upstream rejection, so it does not run it again. Nor
/// does the client's own retry after upstream refused the required tool call
/// it set, which also keeps the lease; a lease renewal after that retry
/// sends no required tool call either.
async fn complete_with_optional_controller_refresh(
    leased: LeasedCredentials,
    options: &RemoteCompletionOptions<'_>,
    input_items: &[Value],
    controller: Option<&ControllerIntegration>,
    credential_id: Option<&str>,
    send_hook: Option<SendHook>,
) -> Result<(CodexCompletion, String)> {
    let first_lease_pinned = leased.pinned_model().is_some();
    let (client, upstream_model, endpoint_for_error, first_input) = build_remote_completion_client(
        leased,
        options,
        input_items,
        true,
        RequiredToolCallAttempt::First,
    )?;
    let mut client = client.with_send_hook(send_hook);

    match client.complete_with_input(&first_input).await {
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
            // The renewed lease carries the controller's pin again; the first
            // attempt already logged it unless that lease had none.
            let required_tool_call_attempt = if client.required_tool_call_refused() {
                RequiredToolCallAttempt::RenewalAfterFallback
            } else {
                RequiredToolCallAttempt::Renewal
            };
            let (mut retry_client, retry_model, retry_endpoint, retry_input) =
                build_remote_completion_client(
                    refreshed,
                    options,
                    input_items,
                    !first_lease_pinned,
                    required_tool_call_attempt,
                )?;

            return retry_client
                .complete_with_input(&retry_input)
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
    let lane = classify_upstream_lane(claims.as_ref())?;
    let service_tier = model_service_tier(lane, &payload)?;
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

    let auth_mode = lane.auth_mode();
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
        route: "/v1/responses",
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
            require_tool_call: require_tool_call_requested(&payload),
        }),
        service_tier: service_tier.upstream.as_ref(),
        service_tier_endpoints: state.service_tier_endpoints,
        required_tool_call_fallbacks: &state.required_tool_call_fallbacks,
    };

    let stream_requested = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let LaneLease {
        leased,
        controller_credential_id,
        source: credential_source,
    } = state.lease_for_lane(lane).await?;
    let send_hook = state.service_tier_override_hook(
        &service_tier,
        &leased.credentials,
        "/v1/responses",
        claims.as_ref(),
    );
    let completion = match complete_with_optional_controller_refresh(
        leased,
        &completion_options,
        &input_items,
        state.controller.as_ref(),
        controller_credential_id,
        send_hook,
    )
    .await
    {
        Ok((response, _upstream_model)) => {
            spawn_credential_usage_report(
                state.controller.as_ref(),
                controller_credential_id,
                &response,
            );
            ProxyCompletion::Remote(response)
        }
        Err(error) => {
            let error = AppError::upstream(error.context(format!(
                "upstream request failed (credential_source={}, requested_model={})",
                credential_source, model,
            )));
            // Upstream codex does not retry an HTTP 429 by itself (only the pinned fork's own
            // patch does), but it retries a stream that fails with `rate_limit_exceeded` after
            // the wait the message names, within its stream retry budget. A transient rate limit
            // on a streaming request is therefore answered that way; a plan limit, and a request
            // that does not stream, keep the HTTP error.
            if stream_requested
                && let Some(rate_limit) = error.upstream.as_ref().and_then(|upstream| {
                    upstream.stream_rate_limit_error(
                        SystemTime::now(),
                        upstream_error::retry_jitter_sample(),
                    )
                })
            {
                eprintln!(
                    "[proxy] upstream rate limit streamed as response.failed {}",
                    json!({
                        "runId": run_id_from_claims(claims.as_ref()),
                        "message": rate_limit["message"],
                    })
                );
                return stream_failed_response(json!({"status": "failed", "error": rate_limit}));
            }
            return Err(error);
        }
    };

    if stream_requested {
        let ProxyCompletion::Remote(remote) = completion;
        return stream_responses_from_value(remote.raw);
    }

    Ok(Json(completion.into_response_body()).into_response())
}

async fn create_chat_completion(
    State(state): State<ProxyState>,
    AuthenticatedProxyClaims(claims): AuthenticatedProxyClaims,
    Json(payload): Json<Value>,
) -> Result<Response, AppError> {
    let lane = classify_upstream_lane(claims.as_ref())?;
    let service_tier = model_service_tier(lane, &payload)?;
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

    let auth_mode = lane.auth_mode();
    let plain_text_completion = plain_text_completion_requested(&payload);
    let proxy_base_instructions = proxy_base_instructions_for_payload(&payload);
    let reasoning_effort = payload
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(normalize_reasoning_effort);
    let completion_options = RemoteCompletionOptions {
        route: "/v1/chat/completions",
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
            require_tool_call: false,
        }),
        service_tier: service_tier.upstream.as_ref(),
        service_tier_endpoints: state.service_tier_endpoints,
        required_tool_call_fallbacks: &state.required_tool_call_fallbacks,
    };

    let LaneLease {
        leased,
        controller_credential_id,
        source: credential_source,
    } = state.lease_for_lane(lane).await?;
    let send_hook = state.service_tier_override_hook(
        &service_tier,
        &leased.credentials,
        "/v1/chat/completions",
        claims.as_ref(),
    );
    let (completion, upstream_model) = match complete_with_optional_controller_refresh(
        leased,
        &completion_options,
        &input_items,
        state.controller.as_ref(),
        controller_credential_id,
        send_hook,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let error = error.context(format!(
                "upstream request failed (credential_source={}, requested_model={})",
                credential_source, requested_model,
            ));
            return Err(AppError::upstream(error));
        }
    };

    spawn_credential_usage_report(
        state.controller.as_ref(),
        controller_credential_id,
        &completion,
    );
    build_remote_chat_response(&payload, completion, upstream_model).await
}

/// A pinned lease serves only its pinned model. Speech and transcription
/// requests name an audio model, which the pinned model cannot stand in for,
/// so these routes refuse the lease before any upstream request instead of
/// spending it on a model the controller did not choose.
fn refuse_audio_on_pinned_lease(leased: &LeasedCredentials, route: &str) -> Result<(), AppError> {
    match leased.pinned_model() {
        Some(pinned_model) => Err(AppError::bad_request(anyhow!(
            "{route} is not available on this credential: it only serves model {pinned_model}"
        ))),
        None => Ok(()),
    }
}

/// Refuses a platform-lane transcription whose form names a `service_tier`
/// other than `default`, as [`refuse_audio_service_tier`] does for a speech
/// request's JSON. OpenAI's transcription request takes no service tier, so
/// the form is forwarded as sent and this adds none.
fn refuse_form_service_tier(
    lane: UpstreamLane<'_>,
    content_type: Option<&str>,
    body: &[u8],
) -> Result<(), AppError> {
    if lane != UpstreamLane::Platform {
        return Ok(());
    }
    for tier in multipart_form_values(content_type, body, "service_tier") {
        refuse_audio_service_tier(
            lane,
            Some(&Value::String(String::from_utf8_lossy(tier).into_owned())),
        )?;
    }
    Ok(())
}

/// The value of every part named `field` in a `multipart/form-data` body;
/// empty for any other content type. It reads only the part headers it
/// needs and accepts bare line feeds, so it finds a field a lenient server
/// would read. It errs toward finding the field: a part counts when any
/// `name` parameter of its `Content-Disposition` names it, and when the
/// part spells its name in RFC 2231 form (`name*`), which this does not
/// decode.
fn multipart_form_values<'b>(
    content_type: Option<&str>,
    body: &'b [u8],
    field: &str,
) -> Vec<&'b [u8]> {
    let mut values = Vec::new();
    let Some(boundary) = content_type.and_then(multipart_boundary) else {
        return values;
    };
    let delimiter = format!("--{boundary}");
    let delimiter = delimiter.as_bytes();
    let find_delimiter = |bytes: &[u8]| {
        bytes
            .windows(delimiter.len())
            .position(|window| window == delimiter)
    };
    // The preamble before the first delimiter is not a part.
    let Some(start) = find_delimiter(body) else {
        return values;
    };
    let mut rest = &body[start + delimiter.len()..];
    // The close delimiter ends the form.
    while !rest.starts_with(b"--") {
        let end = find_delimiter(rest);
        let part = &rest[..end.unwrap_or(rest.len())];
        if let Some(value) = form_part_value(part, field) {
            values.push(value);
        }
        let Some(end) = end else {
            break;
        };
        rest = &rest[end + delimiter.len()..];
    }
    values
}

/// The `boundary` of a `multipart/form-data` content type.
fn multipart_boundary(content_type: &str) -> Option<&str> {
    let mut params = content_type.split(';');
    if !params
        .next()?
        .trim()
        .eq_ignore_ascii_case("multipart/form-data")
    {
        return None;
    }
    params
        .find_map(|param| {
            let (key, value) = param.split_once('=')?;
            key.trim()
                .eq_ignore_ascii_case("boundary")
                .then(|| value.trim().trim_matches('"'))
        })
        .filter(|boundary| !boundary.is_empty())
}

/// The value of one part, the bytes between two delimiters, when its
/// headers name it `field`.
fn form_part_value<'b>(part: &'b [u8], field: &str) -> Option<&'b [u8]> {
    // The line break before the next delimiter belongs to that delimiter.
    let part = part
        .strip_suffix(b"\r\n")
        .or_else(|| part.strip_suffix(b"\n"))
        .unwrap_or(part);
    // The rest of the delimiter line comes first.
    let mut rest = &part[part.iter().position(|&byte| byte == b'\n')? + 1..];
    let mut named = false;
    loop {
        let end = rest.iter().position(|&byte| byte == b'\n')?;
        let line = &rest[..end];
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        rest = &rest[end + 1..];
        // An empty line ends the headers; the value follows.
        if line.is_empty() {
            return named.then_some(rest);
        }
        let Some((name, value)) = std::str::from_utf8(line)
            .ok()
            .and_then(|line| line.split_once(':'))
        else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-disposition") {
            named |= value.split(';').skip(1).any(|param| {
                param.split_once('=').is_some_and(|(key, value)| {
                    let key = key.trim();
                    (key.eq_ignore_ascii_case("name") && value.trim().trim_matches('"') == field)
                        || key
                            .get(..5)
                            .is_some_and(|key| key.eq_ignore_ascii_case("name*"))
                })
            });
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
            .map_err(AppError::upstream)?
            .credentials;
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
    let lane = classify_upstream_lane(claims.as_ref())?;
    // Speech takes no service tier upstream and its body goes as sent, so
    // the platform lane refuses a tier here rather than override it.
    refuse_audio_service_tier(lane, requested_service_tier(&payload))?;
    let LaneLease {
        leased,
        controller_credential_id,
        ..
    } = state.lease_for_lane(lane).await?;

    refuse_audio_on_pinned_lease(&leased, "speech synthesis")?;
    let mut credentials = leased.credentials;
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
    let lane = classify_upstream_lane(claims.as_ref())?;
    let request_content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    refuse_form_service_tier(lane, request_content_type.as_deref(), &body)?;
    let LaneLease {
        leased,
        controller_credential_id,
        ..
    } = state.lease_for_lane(lane).await?;

    refuse_audio_on_pinned_lease(&leased, "speech transcription")?;
    let mut credentials = leased.credentials;
    let request_url = transcription_endpoint_for_credentials(&credentials)?;
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
) -> Result<Response, AppError> {
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
                    "finish_reason": chat_finish_reason(&completion.raw)
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

/// A Chat Completions `finish_reason` for an upstream Responses body. A response the upstream
/// stopped early keeps the text it has, as Chat Completions does, and says why:
/// `content_filter` for a filtered one and `length` for any other reason.
fn chat_finish_reason(raw: &Value) -> &'static str {
    if raw.get("status").and_then(Value::as_str) != Some("incomplete") {
        return "stop";
    }
    match raw
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
    {
        Some("content_filter") => "content_filter",
        _ => "length",
    }
}

/// Streams an upstream Responses body to the client as the Responses events codex reads. A
/// response the upstream stopped early is first reduced to what the client may see, see
/// [`incomplete_response`].
fn stream_responses_from_value(response: Value) -> Result<Response, AppError> {
    stream_completed_response(incomplete_response::delivered_response(response))
}

fn stream_completed_response(mut completed_response: Value) -> Result<Response, AppError> {
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

    events.push(json!({
        "type": "response.created",
        "response": created_response,
    }));

    if let Some(output_items) = completed_response.get("output").cloned() {
        if let Value::Array(items) = output_items {
            for item in items {
                events.push(json!({
                    "type": "response.output_item.added",
                    "item": item,
                }));

                if let Some(text) = collect_output_text_from_item(&item) {
                    events.push(json!({
                        "type": "response.output_text.delta",
                        "delta": text,
                    }));
                }

                events.push(json!({
                    "type": "response.output_item.done",
                    "item": item,
                }));
            }
        }
    }

    events.push(json!({
        "type": "response.completed",
        "response": completed_response,
    }));

    sse_response(events)
}

/// Streams `failed_response`, which carries the `error`, as `response.failed`. It answers a
/// request the upstream refused, which never created a response to announce first.
fn stream_failed_response(failed_response: Value) -> Result<Response, AppError> {
    sse_response(vec![json!({
        "type": "response.failed",
        "response": failed_response,
    })])
}

/// Answers with `events` as server-sent events followed by `[DONE]`, and logs each one when
/// `PROXY_DEBUG_STREAM=1`.
fn sse_response(events: Vec<Value>) -> Result<Response, AppError> {
    let mut sse_events = Vec::with_capacity(events.len() + 1);
    for event in &events {
        sse_events.push(
            Event::default()
                .json_data(event)
                .map_err(AppError::internal)?,
        );
    }
    sse_events.push(Event::default().data("[DONE]"));

    if std::env::var("PROXY_DEBUG_STREAM").as_deref() == Ok("1") {
        for event in events
            .iter()
            .chain(std::iter::once(&json!({"type": "done"})))
        {
            eprintln!(
                "[proxy] stream event: {}",
                serde_json::to_string(event).unwrap_or_else(|_| "<invalid>".into())
            );
        }
    }

    let stream = stream::iter(sse_events.into_iter().map(Ok::<Event, Infallible>));
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
    /// `error.code` of a refusal the proxy makes itself; an upstream failure
    /// takes its code from `upstream`.
    code: Option<&'static str>,
    upstream: Option<upstream_error::ErrorResponse>,
}

impl AppError {
    fn bad_request(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        Self {
            status: StatusCode::BAD_REQUEST,
            error_type: "invalid_request_error",
            message: err.to_string(),
            code: None,
            upstream: None,
        }
    }

    /// A 400 with a stable `error.code` clients can match on.
    fn bad_request_with_code(code: &'static str, err: impl Into<anyhow::Error>) -> Self {
        Self {
            code: Some(code),
            ..Self::bad_request(err)
        }
    }

    fn internal(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error_type: "internal_server_error",
            message: err.to_string(),
            code: None,
            upstream: None,
        }
    }

    fn unauthorized(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        Self {
            status: StatusCode::UNAUTHORIZED,
            error_type: "invalid_authentication",
            message: err.to_string(),
            code: None,
            upstream: None,
        }
    }

    fn upstream(err: impl Into<anyhow::Error>) -> Self {
        let err = err.into();
        let classified = upstream_error::classify(&err);
        Self {
            status: classified.status,
            error_type: classified.error_type,
            message: classified.message.to_string(),
            code: None,
            upstream: Some(classified),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let mut error = json!({
                "message": self.message,
                "type": self.error_type,
        });
        if let Some(code) = self.code {
            error["code"] = json!(code);
        }
        if let Some(upstream) = &self.upstream {
            error["code"] = json!(upstream.code);
            error["retryable"] = json!(upstream.retryable);
            if let Some(resets_at) = upstream.resets_at {
                error["resets_at"] = json!(resets_at);
            }
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

    fn api_key(endpoint: &str, default_model: Option<&str>) -> Credentials {
        Credentials::ApiKey {
            key: "test".to_string(),
            endpoint: Some(endpoint.to_string()),
            default_model: default_model.map(str::to_string),
        }
    }

    fn chatgpt(default_model: &str) -> Credentials {
        Credentials::ChatGpt {
            access_token: "test".to_string(),
            refresh_token: None,
            account_id: None,
            default_model: Some(default_model.to_string()),
            auth_path: None,
        }
    }

    /// The resolve cases above plus the managed credential's shape (an
    /// OpenAI API key defaulting to the managed model), each with the model a
    /// request resolves to without a pin.
    fn resolve_cases() -> Vec<(Credentials, &'static str, &'static str)> {
        let deepseek = api_key(
            "https://api.deepseek.com/v1/chat/completions",
            Some("deepseek-chat"),
        );
        let zai = api_key("https://api.z.ai/api/coding/paas/v4/chat/completions", None);
        let openai_without_default = api_key("https://api.openai.com/v1/responses", None);
        let managed = api_key("https://api.openai.com/v1/responses", Some("gpt-6-luna"));
        vec![
            (deepseek.clone(), "gpt-5-codex", "deepseek-chat"),
            (deepseek.clone(), "gpt-4.5", "deepseek-chat"),
            (deepseek.clone(), "o3-mini", "deepseek-chat"),
            (deepseek.clone(), "deepseek-chat", "deepseek-chat"),
            (deepseek, "glm-4.5", "deepseek-chat"),
            (zai.clone(), "gpt-5-codex", "glm-5"),
            (zai, "deepseek-chat", "glm-5"),
            (chatgpt("gpt-5.5"), "glm-4.5", "gpt-5.5"),
            (chatgpt("gpt-5.5"), "deepseek-chat", "gpt-5.5"),
            (chatgpt("gpt-5.5"), "gemini-2.5-pro", "gpt-5.5"),
            (chatgpt("gpt-5.5"), "gpt-5.5", "gpt-5.5"),
            (chatgpt("gpt-5.6-sol"), "gpt-5.5", "gpt-5.5"),
            (chatgpt("gpt-5.6-sol"), "gpt-5.6-sol", "gpt-5.6-sol"),
            (chatgpt("gpt-5.6-sol"), "gpt-5.5-mini", "gpt-5.5-mini"),
            (chatgpt("gpt-5.6-sol"), "", "gpt-5.6-sol"),
            (chatgpt("gpt-5.6-sol"), "   ", "gpt-5.6-sol"),
            (openai_without_default.clone(), "", DEFAULT_MODEL),
            (openai_without_default, "gpt-5.6-sol", "gpt-5.6-sol"),
            // Without a pin the managed key honours any explicit id, which is
            // how jobs without managedAiUsed reached the runtime default.
            (managed.clone(), "gpt-5.6-sol", "gpt-5.6-sol"),
            (managed.clone(), "", "gpt-6-luna"),
            (managed.clone(), "   ", "gpt-6-luna"),
            (managed.clone(), "gpt-5-codex", "gpt-5-codex"),
            (managed.clone(), "gpt-5.5", "gpt-5.5"),
            (managed.clone(), "deepseek-chat", "deepseek-chat"),
            (managed.clone(), "gemini-2.5-pro", "gemini-2.5-pro"),
            (managed, "gpt-6-luna", "gpt-6-luna"),
        ]
    }

    #[test]
    fn resolve_model_for_lease_overrides_the_request_only_on_a_pinned_lease() {
        for (credentials, requested, expected) in resolve_cases() {
            assert_eq!(
                resolve_model_for_credentials(requested, &credentials),
                expected,
                "credential rule for {requested:?}"
            );
            // No pin, and a blank pin, keep today's result.
            for pinned_model in [None, Some("   ".to_string())] {
                let leased = LeasedCredentials {
                    credentials: credentials.clone(),
                    pinned_model,
                };
                assert_eq!(
                    resolve_model_for_lease(requested, &leased),
                    expected,
                    "unpinned lease for {requested:?}"
                );
            }
            // Whatever the request names (the runtime default, nothing, a
            // ChatGPT id, another provider's id) and whatever the
            // credential's own rules pick, a pinned lease goes out as the
            // pinned model.
            let leased = LeasedCredentials {
                credentials,
                pinned_model: Some("gpt-6-luna".to_string()),
            };
            assert_eq!(
                resolve_model_for_lease(requested, &leased),
                "gpt-6-luna",
                "pinned lease for {requested:?}"
            );
        }
    }

    #[test]
    fn audio_routes_refuse_a_pinned_lease() {
        let pinned = LeasedCredentials {
            credentials: api_key("https://api.openai.com/v1/responses", Some("gpt-6-luna")),
            pinned_model: Some("gpt-6-luna".to_string()),
        };
        let error = refuse_audio_on_pinned_lease(&pinned, "speech synthesis")
            .expect_err("a pinned lease serves no audio model");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            error.message,
            "speech synthesis is not available on this credential: it only serves model gpt-6-luna"
        );

        let unpinned = LeasedCredentials::unpinned(pinned.credentials.clone());
        assert!(refuse_audio_on_pinned_lease(&unpinned, "speech synthesis").is_ok());
    }

    /// A proxy with static credentials and no controller. The lanes a
    /// controller would add are served the same way without one.
    fn static_state(credentials: Credentials, pinned_model: Option<&str>) -> ProxyState {
        ProxyState {
            backend: ProxyBackend::RemoteStatic(StaticCredentials::new(
                credentials,
                pinned_model.map(str::to_string),
            )),
            controller: None,
            require_controller_auth: false,
            require_credential_claim: false,
            service_tier_overrides: Arc::new(AtomicU64::new(0)),
            service_tier_endpoints: ServiceTierEndpoints::default(),
            required_tool_call_fallbacks: Arc::new(AtomicU64::new(0)),
        }
    }

    #[tokio::test]
    async fn static_credentials_pin_only_the_platform_lane_to_the_proxy_pinned_model() {
        let managed_key = api_key("https://api.openai.com/v1/responses", None);
        let state = static_state(managed_key.clone(), Some(" gpt-6-luna "));
        // A dispatch job token that names no credential is a managed run on
        // the operator's key: pinned like the controller's managed lease.
        let lease = state
            .lease_for_lane(UpstreamLane::Platform)
            .await
            .unwrap_or_else(|_| panic!("platform lane"));
        assert_eq!(lease.source, "static");
        assert!(lease.controller_credential_id.is_none());
        assert_eq!(lease.leased.pinned_model(), Some("gpt-6-luna"));
        assert_eq!(
            resolve_model_for_lease("gpt-5.6-sol", &lease.leased),
            "gpt-6-luna"
        );
        assert!(refuse_audio_on_pinned_lease(&lease.leased, "speech synthesis").is_err());

        // A proxy without a controller checks no token and pins nothing.
        let lease = state
            .lease_for_lane(UpstreamLane::Unauthenticated)
            .await
            .unwrap_or_else(|_| panic!("unauthenticated lane"));
        assert_eq!(lease.source, "static");
        assert!(lease.leased.pinned_model().is_none());
        assert_eq!(
            resolve_model_for_lease("gpt-5.6-sol", &lease.leased),
            "gpt-5.6-sol"
        );

        // A user's own credential needs the controller to lease it.
        let error = state
            .lease_for_lane(UpstreamLane::Byo {
                credential_id: "cred-1",
            })
            .await
            .err()
            .expect("no controller to lease from");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            error.message,
            "proxy controller integration is not configured"
        );

        // A blank setting is no pin.
        let blank = StaticCredentials::new(managed_key, Some("   ".into()));
        assert!(blank.platform_lease().pinned_model().is_none());
    }

    #[test]
    fn static_credentials_without_a_pinned_model_warn_once_about_managed_runs() {
        let static_creds =
            StaticCredentials::new(api_key("https://api.openai.com/v1/responses", None), None);
        let warnings = || {
            static_creds
                .unpinned_managed_run_warnings
                .load(Ordering::Relaxed)
        };
        // Requests that are not managed runs have nothing to warn about.
        static_creds.unauthenticated_lease();
        assert_eq!(warnings(), 0);

        // Managed runs keep today's behaviour, and the proxy says once that
        // the managed model is not pinned. Handlers get a clone of the state,
        // so the count is shared.
        for _ in 0..3 {
            let leased = static_creds.clone().platform_lease();
            assert!(leased.pinned_model().is_none());
            assert_eq!(
                resolve_model_for_lease("gpt-5.6-sol", &leased),
                "gpt-5.6-sol"
            );
            assert!(refuse_audio_on_pinned_lease(&leased, "speech synthesis").is_ok());
        }
        assert_eq!(warnings(), 1);

        // A pinned proxy has nothing to warn about.
        let pinned = StaticCredentials::new(
            api_key("https://api.openai.com/v1/responses", None),
            Some("gpt-6-luna".into()),
        );
        pinned.platform_lease();
        assert_eq!(
            pinned.unpinned_managed_run_warnings.load(Ordering::Relaxed),
            0
        );
    }

    #[test]
    fn upstream_lane_classifies_byo_platform_session_and_unauthenticated() {
        // A token naming a credential is BYO whether or not it carries a
        // run_id, and a blank credential_id is no credential.
        for claims in [
            controller_claims(Some("run-1"), Some("cred-1")),
            controller_claims(None, Some(" cred-1 ")),
        ] {
            let lane = classify_upstream_lane(Some(&claims)).expect("byo lane");
            assert_eq!(
                lane,
                UpstreamLane::Byo {
                    credential_id: "cred-1"
                }
            );
            assert_eq!(lane.auth_mode(), "byoc");
        }

        // A dispatch job token that names no credential: the platform lane.
        for claims in [
            controller_claims(Some("run-1"), None),
            controller_claims(Some("run-1"), Some("   ")),
        ] {
            let lane = classify_upstream_lane(Some(&claims)).expect("platform lane");
            assert_eq!(lane, UpstreamLane::Platform);
            assert_eq!(lane.auth_mode(), "managed");
        }

        // The agent-login and runtime-register envelopes: no run_id, no
        // credential. Refused with the exact pre-existing rejection, which
        // the controller recognises in a failed turn's error.
        for claims in [
            controller_claims(None, None),
            controller_claims(Some("   "), None),
            controller_claims(None, Some("")),
        ] {
            let error = classify_upstream_lane(Some(&claims)).expect_err("session envelope");
            assert_eq!(error.status, StatusCode::UNAUTHORIZED);
            assert_eq!(error.message, BYOC_REJECTION);
        }

        // The platform lane's own credential id is never a token's
        // credential, whatever its spelling or whether a run_id comes with it.
        let upper = MANAGED_AI_CREDENTIAL_ID.to_ascii_uppercase();
        let braced = format!("{{{MANAGED_AI_CREDENTIAL_ID}}}");
        let simple = MANAGED_AI_CREDENTIAL_ID.replace('-', "");
        for credential_id in [
            MANAGED_AI_CREDENTIAL_ID,
            upper.as_str(),
            braced.as_str(),
            simple.as_str(),
        ] {
            for run_id in [Some("run-1"), None] {
                let claims = controller_claims(run_id, Some(credential_id));
                let error =
                    classify_upstream_lane(Some(&claims)).expect_err("reserved credential id");
                assert_eq!(error.status, StatusCode::UNAUTHORIZED, "{credential_id}");
            }
        }
        let other = Uuid::new_v4().to_string();
        let claims = controller_claims(Some("run-1"), Some(other.as_str()));
        assert_eq!(
            classify_upstream_lane(Some(&claims)).expect("byo lane"),
            UpstreamLane::Byo {
                credential_id: other.as_str()
            }
        );

        // No claims: the proxy has no controller integration.
        let lane = classify_upstream_lane(None).expect("unauthenticated lane");
        assert_eq!(lane, UpstreamLane::Unauthenticated);
        assert_eq!(lane.auth_mode(), "managed");
    }

    /// A model request with `service_tier` set to `tier`, or left out for
    /// `None`.
    fn tier_request(tier: Option<Value>) -> Value {
        match tier {
            Some(tier) => json!({ "model": "gpt-6-luna", "service_tier": tier }),
            None => json!({ "model": "gpt-6-luna" }),
        }
    }

    /// Checks `error` is the platform lane's coded refusal of a tier.
    fn assert_service_tier_not_allowed(error: &AppError, context: &str) {
        assert_eq!(error.status, StatusCode::BAD_REQUEST, "{context}");
        assert_eq!(error.error_type, "invalid_request_error", "{context}");
        assert_eq!(error.code, Some(SERVICE_TIER_NOT_ALLOWED), "{context}");
        assert!(
            error
                .message
                .contains("the platform key serves only the default tier"),
            "{context}: {}",
            error.message
        );
    }

    /// Strings codex or a hand-built request may send as a tier, none of
    /// them exactly `default`.
    const OTHER_STRING_TIERS: [&str; 7] = [
        "auto", "priority", "flex", "scale", "Default", " default", "",
    ];

    #[test]
    fn model_requests_are_held_to_the_default_tier_on_the_platform_lane_only() {
        let byo = UpstreamLane::Byo {
            credential_id: "cred-1",
        };
        let non_strings = [
            json!(1),
            json!(true),
            json!({ "tier": "default" }),
            json!(["default"]),
        ];

        // No tier, an explicit null, and "default" all go out as "default"
        // on the platform key, with nothing overridden.
        for tier in [None, Some(Value::Null), Some(json!("default"))] {
            let payload = tier_request(tier);
            assert_eq!(
                model_service_tier(UpstreamLane::Platform, &payload).expect("platform tier"),
                ModelServiceTier {
                    upstream: Some(json!("default")),
                    overridden: None,
                },
                "{payload}"
            );
        }

        // Any other string goes out as "default" too, and is reported as
        // overridden so the caller can count it.
        for tier in OTHER_STRING_TIERS {
            let payload = tier_request(Some(json!(tier)));
            assert_eq!(
                model_service_tier(UpstreamLane::Platform, &payload).expect("platform tier"),
                ModelServiceTier {
                    upstream: Some(json!("default")),
                    overridden: Some(tier),
                },
                "{tier:?}"
            );
        }

        // Codex never sends a tier that is not a string, so the platform
        // lane refuses one.
        for tier in &non_strings {
            let error =
                model_service_tier(UpstreamLane::Platform, &tier_request(Some(tier.clone())))
                    .expect_err("platform refuses the tier");
            assert_service_tier_not_allowed(&error, &tier.to_string());
        }

        // A user's own credential and a proxy without a controller send no
        // tier, whatever the request asks, as the proxy always has.
        let every_tier = [None, Some(Value::Null), Some(json!("default"))]
            .into_iter()
            .chain(OTHER_STRING_TIERS.map(|tier| Some(json!(tier))))
            .chain(non_strings.iter().cloned().map(Some));
        for tier in every_tier {
            let payload = tier_request(tier);
            for lane in [byo, UpstreamLane::Unauthenticated] {
                assert_eq!(
                    model_service_tier(lane, &payload).expect("no tier"),
                    ModelServiceTier {
                        upstream: None,
                        overridden: None,
                    },
                    "{lane:?} {payload}"
                );
            }
        }
    }

    #[test]
    fn audio_requests_refuse_every_other_tier_on_the_platform_lane_only() {
        let byo = UpstreamLane::Byo {
            credential_id: "cred-1",
        };
        for tier in [None, Some(json!("default"))] {
            for lane in [UpstreamLane::Platform, byo, UpstreamLane::Unauthenticated] {
                assert!(
                    refuse_audio_service_tier(lane, tier.as_ref()).is_ok(),
                    "{lane:?} {tier:?}"
                );
            }
        }
        let other_tiers = OTHER_STRING_TIERS
            .map(|tier| json!(tier))
            .into_iter()
            .chain([json!(1), json!(true), json!({ "tier": "default" })]);
        for tier in other_tiers {
            let error = refuse_audio_service_tier(UpstreamLane::Platform, Some(&tier))
                .expect_err("platform refuses the tier");
            assert_service_tier_not_allowed(&error, &tier.to_string());
            for lane in [byo, UpstreamLane::Unauthenticated] {
                assert!(
                    refuse_audio_service_tier(lane, Some(&tier)).is_ok(),
                    "{lane:?} {tier}"
                );
            }
        }

        // A short string is named; a long one is not echoed.
        let error = refuse_audio_service_tier(UpstreamLane::Platform, Some(&json!("flex")))
            .expect_err("flex");
        assert!(
            error.message.starts_with("service_tier \"flex\" is not"),
            "{}",
            error.message
        );
        let long = "p".repeat(4096);
        let error = refuse_audio_service_tier(UpstreamLane::Platform, Some(&json!(long)))
            .expect_err("long tier");
        assert!(!error.message.contains(&long[..33]), "{}", error.message);
    }

    #[test]
    fn platform_lane_service_tier_overrides_are_counted_once_per_request() {
        let managed_key = api_key("https://api.openai.com/v1/responses", None);
        let state = static_state(managed_key.clone(), Some("gpt-6-luna"));
        let overrides = || state.platform_lane_report()["serviceTierOverrides"].clone();
        assert_eq!(overrides(), json!(0));
        // The hook the request's client runs when it goes upstream.
        let hook = |state: &ProxyState, lane, tier: Option<Value>, credentials: &Credentials| {
            let payload = tier_request(tier);
            let tier = model_service_tier(lane, &payload).expect("tier");
            state.service_tier_override_hook(&tier, credentials, "/v1/responses", None)
        };

        // Each overridden platform-lane request counts once, when its hook
        // runs rather than when the handler takes it, on any clone of the
        // state, since handlers get a clone.
        for (count, requested) in OTHER_STRING_TIERS.into_iter().enumerate() {
            let send_hook = hook(
                &state.clone(),
                UpstreamLane::Platform,
                Some(json!(requested)),
                &managed_key,
            )
            .expect("overridden");
            assert_eq!(overrides(), json!(count), "{requested:?} before it runs");
            send_hook();
            assert_eq!(overrides(), json!(count + 1), "{requested:?}");
        }

        // A ChatGPT login drops the tier rather than replace it, which is
        // an override too.
        let counted = overrides();
        hook(
            &state,
            UpstreamLane::Platform,
            Some(json!("priority")),
            &chatgpt("gpt-6-luna"),
        )
        .expect("overridden")();
        assert_eq!(overrides(), json!(counted.as_u64().expect("count") + 1));
        let counted = overrides();

        // The default tier, no tier and every other lane override nothing,
        // so they get no hook.
        for requested in [None, Some(Value::Null), Some(json!("default"))] {
            assert!(
                hook(
                    &state,
                    UpstreamLane::Platform,
                    requested.clone(),
                    &managed_key
                )
                .is_none(),
                "{requested:?}"
            );
        }
        for lane in [
            UpstreamLane::Byo {
                credential_id: "cred-1",
            },
            UpstreamLane::Unauthenticated,
        ] {
            assert!(
                hook(&state, lane, Some(json!("priority")), &managed_key).is_none(),
                "{lane:?}"
            );
        }
        assert_eq!(overrides(), counted);
    }

    /// A platform-lane request that asked for `requested`, which the lane
    /// overrides.
    fn overridden_tier(requested: &str) -> ModelServiceTier<'_> {
        ModelServiceTier {
            upstream: Some(json!("default")),
            overridden: Some(requested),
        }
    }

    #[test]
    fn a_service_tier_override_logs_at_most_the_start_of_the_requested_tier() {
        let managed_key = api_key("https://api.openai.com/v1/responses", None);
        let record = |requested, route, run_id| {
            service_tier_override_record(
                &overridden_tier(requested),
                &managed_key,
                ServiceTierEndpoints::default(),
                route,
                run_id,
            )
            .expect("overridden")
        };
        assert_eq!(
            record("priority", "/v1/responses", Some("run-1")),
            json!({
                "requestedServiceTier": "priority",
                "truncated": false,
                "serviceTier": "default",
                "route": "/v1/responses",
                "runId": "run-1",
            })
        );

        // A tier of any length logs its first 32 characters, cut on a
        // character boundary.
        let long = format!("{}{}", "å".repeat(31), "p".repeat(1 << 20));
        let logged = record(&long, "/v1/chat/completions", None);
        assert_eq!(
            logged["requestedServiceTier"],
            json!(format!("{}p", "å".repeat(31)))
        );
        assert_eq!(logged["truncated"], json!(true));
        assert_eq!(logged["runId"], json!(null));
        let exact = "p".repeat(32);
        let logged = record(&exact, "/v1/responses", None);
        assert_eq!(logged["requestedServiceTier"], json!(exact));
        assert_eq!(logged["truncated"], json!(false));

        // A request the lane did not override logs nothing.
        let not_overridden = ModelServiceTier {
            upstream: Some(json!("default")),
            overridden: None,
        };
        assert_eq!(
            service_tier_override_record(
                &not_overridden,
                &managed_key,
                ServiceTierEndpoints::default(),
                "/v1/responses",
                None
            ),
            None
        );
    }

    #[test]
    fn a_service_tier_override_logs_the_tier_the_credentials_are_sent() {
        use ServiceTierEndpoints::{All, Never, OpenAi};
        let logged_tier = |credentials: &Credentials, endpoints| {
            service_tier_override_record(
                &overridden_tier("priority"),
                credentials,
                endpoints,
                "/v1/responses",
                None,
            )
            .expect("overridden")["serviceTier"]
                .clone()
        };

        // The OpenAI API gets "default", on either wire API, unless the
        // setting is none. An OpenAI-compatible provider gets it only with
        // the setting all.
        for (endpoint, sent_by_default) in [
            ("https://api.openai.com/v1/responses", true),
            ("https://api.openai.com/v1/chat/completions", true),
            ("https://api.groq.com/openai/v1/responses", false),
            ("http://127.0.0.1:8080/v1/chat/completions", false),
        ] {
            let credentials = api_key(endpoint, None);
            for (endpoints, sent) in [(OpenAi, sent_by_default), (All, true), (Never, false)] {
                let expected = if sent { json!("default") } else { json!(null) };
                assert_eq!(
                    logged_tier(&credentials, endpoints),
                    expected,
                    "{endpoint} {endpoints:?}"
                );
            }
        }

        // A ChatGPT login and Gemini Code Assist are sent no tier, so the
        // requested one is dropped, and the log says none went upstream.
        let gemini = Credentials::GeminiCodeAssist {
            access_token: "test".to_string(),
            project_id: "project".to_string(),
            endpoint: None,
            default_model: None,
        };
        let gemini_endpoint = api_key(
            "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
            None,
        );
        for (name, credentials) in [
            ("chatgpt", chatgpt("gpt-6-luna")),
            ("gemini", gemini),
            ("gemini endpoint", gemini_endpoint),
        ] {
            for endpoints in [OpenAi, All, Never] {
                let record = service_tier_override_record(
                    &overridden_tier("priority"),
                    &credentials,
                    endpoints,
                    "/v1/responses",
                    Some("run-1"),
                )
                .expect("overridden");
                assert_eq!(
                    record,
                    json!({
                        "requestedServiceTier": "priority",
                        "truncated": false,
                        "serviceTier": null,
                        "route": "/v1/responses",
                        "runId": "run-1",
                    }),
                    "{name} {endpoints:?}"
                );
            }
        }
    }

    #[test]
    fn multipart_form_values_read_only_the_named_parts() {
        let form = |line_break: &str| {
            [
                // A preamble and an epilogue shaped like parts.
                "",
                "Content-Disposition: form-data; name=\"service_tier\"",
                "",
                "flex",
                "--b1",
                "Content-Disposition: form-data; name=\"model\"",
                "",
                "gpt-4o-transcribe",
                "--b1  ",
                "CONTENT-DISPOSITION: Form-Data; NAME=service_tier",
                "",
                "priority",
                "--b1",
                "Content-Disposition: form-data; name=\"file\"; filename=\"a.wav\"",
                "Content-Type: audio/wav",
                "",
                "Content-Disposition: form-data; name=\"service_tier\"",
                "--b1",
                "content-disposition: form-data; name=\"service_tier\"",
                "",
                "",
                "--b1--",
                "Content-Disposition: form-data; name=\"service_tier\"",
                "",
                "scale",
                "",
            ]
            .join(line_break)
            .into_bytes()
        };
        for line_break in ["\r\n", "\n"] {
            let body = form(line_break);
            for content_type in [
                "multipart/form-data; boundary=b1",
                "Multipart/Form-Data ; charset=utf-8; Boundary=\"b1\"",
            ] {
                // The named parts, not the preamble, the epilogue or a
                // file's contents; an empty value is still a value.
                assert_eq!(
                    multipart_form_values(Some(content_type), &body, "service_tier"),
                    vec![b"priority".as_slice(), b"".as_slice()],
                    "{content_type} {line_break:?}"
                );
            }
            for content_type in [
                None,
                Some("application/json"),
                Some("multipart/mixed; boundary=b1"),
                Some("multipart/form-data"),
                Some("multipart/form-data; boundary=\"\""),
                Some("multipart/form-data; boundary=b2"),
            ] {
                assert!(
                    multipart_form_values(content_type, &body, "service_tier").is_empty(),
                    "{content_type:?}"
                );
            }
        }

        // A value keeps its own line breaks, and a form whose close
        // delimiter is missing is read to its end.
        let body = b"--b1\r\nContent-Disposition: form-data; name=service_tier\r\n\r\nflex\r\n\r\n--b1\r\nContent-Disposition: form-data; name=service_tier\r\n\r\nauto";
        assert_eq!(
            multipart_form_values(
                Some("multipart/form-data; boundary=b1"),
                body,
                "service_tier"
            ),
            vec![b"flex\r\n".as_slice(), b"auto".as_slice()]
        );

        // Any `name` in the disposition counts, even one a quoted filename
        // hides, so a filename that holds another name ahead of the real
        // one cannot slip a tier past the check.
        // So does a name in RFC 2231 form, which may spell any field.
        for disposition in [
            "form-data; filename=\"x; name=file\"; name=\"service_tier\"",
            "form-data; filename=\"x; name=service_tier\"; name=\"file\"",
            "form-data; name*=utf-8''service%5Ftier",
            "form-data; NAME*0=\"service\"; name*1=\"_tier\"",
        ] {
            let body =
                format!("--b1\r\nContent-Disposition: {disposition}\r\n\r\npriority\r\n--b1--\r\n");
            assert_eq!(
                multipart_form_values(
                    Some("multipart/form-data; boundary=b1"),
                    body.as_bytes(),
                    "service_tier"
                ),
                vec![b"priority".as_slice()],
                "{disposition}"
            );
        }
        let body = b"--b1\r\nContent-Disposition: form-data; name=\"file\"; filename*=utf-8''a%C3%A5.wav\r\n\r\npriority\r\n--b1--\r\n";
        assert!(
            multipart_form_values(
                Some("multipart/form-data; boundary=b1"),
                body,
                "service_tier"
            )
            .is_empty()
        );
    }

    #[test]
    fn transcription_forms_are_held_to_the_default_tier_on_the_platform_lane_only() {
        let content_type = Some("multipart/form-data; boundary=b1");
        let form = |tier: Option<&[u8]>| {
            let mut body =
                b"--b1\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-4o-transcribe\r\n"
                    .to_vec();
            if let Some(tier) = tier {
                body.extend_from_slice(
                    b"--b1\r\nContent-Disposition: form-data; name=\"service_tier\"\r\n\r\n",
                );
                body.extend_from_slice(tier);
                body.extend_from_slice(b"\r\n");
            }
            body.extend_from_slice(b"--b1--\r\n");
            body
        };
        let byo = UpstreamLane::Byo {
            credential_id: "cred-1",
        };
        let lanes = [UpstreamLane::Platform, byo, UpstreamLane::Unauthenticated];

        for body in [form(None), form(Some(b"default"))] {
            for lane in lanes {
                assert!(
                    refuse_form_service_tier(lane, content_type, &body).is_ok(),
                    "{lane:?}"
                );
            }
        }
        for tier in [
            b"priority".as_slice(),
            b"auto",
            b"flex",
            b"scale",
            b"Default",
            b"",
            b"\xff",
        ] {
            let body = form(Some(tier));
            let error = refuse_form_service_tier(UpstreamLane::Platform, content_type, &body)
                .expect_err("platform refuses the tier");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(error.code, Some(SERVICE_TIER_NOT_ALLOWED));
            assert!(
                error
                    .message
                    .contains("the platform key serves only the default tier"),
                "{}",
                error.message
            );
            for lane in [byo, UpstreamLane::Unauthenticated] {
                assert!(
                    refuse_form_service_tier(lane, content_type, &body).is_ok(),
                    "{lane:?}"
                );
            }
        }

        // A second tier after a default one is refused too.
        let mut body = form(Some(b"default"));
        body.truncate(body.len() - b"--b1--\r\n".len());
        body.extend_from_slice(
            b"--b1\r\nContent-Disposition: form-data; name=\"service_tier\"\r\n\r\npriority\r\n--b1--\r\n",
        );
        assert!(refuse_form_service_tier(UpstreamLane::Platform, content_type, &body).is_err());
    }

    #[tokio::test]
    async fn a_coded_refusal_carries_its_code_in_the_error_envelope() {
        let response = AppError::bad_request_with_code(
            SERVICE_TIER_NOT_ALLOWED,
            anyhow!("the platform key serves only the default tier"),
        )
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(
            serde_json::from_slice::<Value>(&body).expect("json"),
            json!({
                "error": {
                    "message": "the platform key serves only the default tier",
                    "type": "invalid_request_error",
                    "code": "service_tier_not_allowed",
                }
            })
        );

        // An uncoded 400 keeps today's envelope, with no code.
        let response = AppError::bad_request(anyhow!("bad input")).into_response();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(
            serde_json::from_slice::<Value>(&body).expect("json"),
            json!({ "error": { "message": "bad input", "type": "invalid_request_error" } })
        );
    }

    #[test]
    fn platform_lane_report_names_the_static_credential_kind() {
        let gemini = Credentials::GeminiCodeAssist {
            access_token: "test".to_string(),
            project_id: "project".to_string(),
            endpoint: None,
            default_model: None,
        };
        for (credentials, kind) in [
            (
                api_key("https://api.openai.com/v1/responses", None),
                "api_key",
            ),
            (chatgpt("gpt-5.5"), "chatgpt"),
            (gemini, "gemini_code_assist"),
        ] {
            let report = static_state(credentials, Some("gpt-6-luna")).platform_lane_report();
            assert_eq!(report["servedBy"], json!("static"));
            assert_eq!(report["staticCredentialKind"], json!(kind));
            // Without a controller no token marks a managed run, so
            // PROXY_PINNED_MODEL pins nothing and no token is refused.
            assert_eq!(report["pinnedModel"], json!(null));
            assert_eq!(report["sessionTokensRefused"], json!(false));
            assert_eq!(report["serviceTier"], json!(null));
            assert_eq!(report["serviceTierOverrides"], json!(0));
            assert_eq!(report["reportsUsage"], json!(false));
        }
    }

    #[test]
    fn pinned_lease_tool_types_match_the_codex_tool_spec() {
        // A codex update that adds a tool type fails here, so the type is
        // allowed on a pinned lease, or kept off it, on purpose: every codex
        // type is either allowed or a hosted type a pinned lease drops.
        const TOOL_SPEC: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../codex/codex-rs/tools/src/tool_spec.rs"
        ));
        let variants = TOOL_SPEC
            .split("pub enum ToolSpec {")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .expect("codex ToolSpec enum");
        let mut codex_types = variants
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("#[serde(rename = \"")?
                    .strip_suffix("\")]")
            })
            .collect::<Vec<_>>();
        codex_types.sort_unstable();
        assert!(
            PINNED_LEASE_TOOL_TYPES
                .iter()
                .all(|allowed| !PINNED_LEASE_DROPPED_TOOL_TYPES.contains(allowed)),
            "a type is either allowed or dropped"
        );
        let mut accounted = PINNED_LEASE_TOOL_TYPES.to_vec();
        accounted.extend(PINNED_LEASE_DROPPED_TOOL_TYPES);
        accounted.sort_unstable();
        assert_eq!(codex_types, accounted);
    }

    #[test]
    fn pinned_lease_forwards_the_codex_tool_types_except_hosted_ones() {
        // One entry per codex ToolSpec variant, shaped as codex serialises it.
        // A property named `model` inside a function's schema is an argument,
        // not the tool's own model.
        let codex_client_tools = vec![
            json!({
                "type": "function",
                "name": "exec_command",
                "description": "Runs a command.",
                "strict": false,
                "parameters": {
                    "type": "object",
                    "properties": { "model": { "type": "string" } }
                }
            }),
            json!({
                "type": "custom",
                "name": "apply_patch",
                "description": "Edit files.",
                "format": { "type": "grammar", "syntax": "lark", "definition": "start: /.+/" }
            }),
            json!({
                "type": "namespace",
                "name": "mcp__browser",
                "description": "Tools in the mcp__browser namespace.",
                "tools": [{
                    "type": "function",
                    "name": "observe",
                    "description": "Observe the page.",
                    "strict": false,
                    "parameters": { "type": "object", "properties": {} }
                }]
            }),
            json!({
                "type": "tool_search",
                "execution": "client",
                "description": "Search deferred tools.",
                "parameters": { "type": "object", "properties": {} }
            }),
        ];
        let mut codex_tools = codex_client_tools.clone();
        codex_tools.push(json!({ "type": "web_search", "external_web_access": true }));
        let (kept, dropped) = tools_for_pinned_lease(&codex_tools, "tools");
        assert_eq!(
            kept, codex_client_tools,
            "every client tool codex emits goes upstream as is"
        );
        assert_eq!(
            dropped
                .iter()
                .map(|tool| (tool.carrier, tool.tool_type.as_str(), tool.reason))
                .collect::<Vec<_>>(),
            vec![("tools", "web_search", "hosted")],
            "hosted web search stays off a pinned lease"
        );

        let hand_built = vec![
            json!({ "type": "image_generation", "model": "gpt-image-1" }),
            json!({ "type": "code_interpreter", "container": { "type": "auto" } }),
            json!({ "type": "local_shell" }),
            json!({ "type": "function", "name": "f", "parameters": {}, "model": "gpt-5.6-sol" }),
            json!({
                "type": "namespace",
                "name": "n",
                "tools": [{ "type": "image_generation" }]
            }),
            json!({ "name": "untyped" }),
            json!("function"),
        ];
        let (kept, dropped) = tools_for_pinned_lease(&hand_built, "tools");
        assert!(
            kept.is_empty(),
            "nothing hand-built goes upstream: {kept:?}"
        );
        assert_eq!(
            dropped
                .iter()
                .map(|tool| (tool.carrier, tool.tool_type.as_str(), tool.reason))
                .collect::<Vec<_>>(),
            vec![
                ("tools", "image_generation", "type"),
                ("tools", "code_interpreter", "type"),
                ("tools", "local_shell", "type"),
                ("tools", "function", "model"),
                ("tools", "namespace", "member"),
                ("tools", "unknown", "type"),
                ("tools", "unknown", "type"),
            ]
        );
    }

    #[test]
    fn require_tool_call_is_requested_only_by_the_key_set_to_one() {
        let with_metadata = |metadata: Value| json!({ "client_metadata": metadata });
        assert!(require_tool_call_requested(&with_metadata(json!({
            "thread_id": "thread-1",
            "instafy.require_tool_call": "1",
        }))));
        for value in [
            json!("0"),
            json!("true"),
            json!(""),
            json!(" 1"),
            json!(1),
            json!(true),
            Value::Null,
        ] {
            assert!(
                !require_tool_call_requested(&with_metadata(
                    json!({ "instafy.require_tool_call": value })
                )),
                "{value}"
            );
        }
        assert!(!require_tool_call_requested(&json!({})));
        assert!(!require_tool_call_requested(
            &json!({ "client_metadata": "1" })
        ));
        // `metadata` is not `client_metadata`.
        assert!(!require_tool_call_requested(&json!({
            "metadata": { "instafy.require_tool_call": "1" }
        })));
    }

    #[test]
    fn required_tool_call_applies_to_offered_tools_left_to_the_model() {
        let tool = json!({ "type": "function", "name": "exec_command", "parameters": {} });
        let tools = [tool.clone()];
        let message = json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": "hi" }]
        });
        let lite_input = [
            json!({ "type": "additional_tools", "role": "developer", "tools": [tool] }),
            message.clone(),
        ];
        let plain_input = [message.clone()];
        let empty_lite_input = [
            json!({ "type": "additional_tools", "role": "developer", "tools": [] }),
            message.clone(),
        ];
        // `tool_search_output` carries tools the model already found, not
        // the tools the request offers.
        let tool_search_input = [
            json!({
                "type": "tool_search_output",
                "execution": "client",
                "tools": [{ "type": "function", "name": "found", "parameters": {} }]
            }),
            message,
        ];
        let auto = json!("auto");
        let responses = api_key("https://api.openai.com/v1/responses", None);

        // Tools offered in `tools` or in an `additional_tools` item, with
        // the choice left to the model.
        assert!(required_tool_call_applies(
            true,
            &responses,
            true,
            Some(&tools),
            &plain_input,
            Some(&auto)
        ));
        assert!(required_tool_call_applies(
            true,
            &responses,
            true,
            Some(&tools),
            &plain_input,
            None
        ));
        assert!(required_tool_call_applies(
            true,
            &responses,
            true,
            None,
            &lite_input,
            Some(&auto)
        ));
        assert!(required_tool_call_applies(
            true,
            &responses,
            true,
            Some(&[]),
            &lite_input,
            None
        ));

        // Not asked for, or a plain text completion.
        assert!(!required_tool_call_applies(
            false,
            &responses,
            true,
            Some(&tools),
            &lite_input,
            Some(&auto)
        ));
        assert!(!required_tool_call_applies(
            true,
            &responses,
            false,
            Some(&tools),
            &lite_input,
            Some(&auto)
        ));

        // No tools offered.
        for input in [&plain_input[..], &empty_lite_input, &tool_search_input] {
            assert!(
                !required_tool_call_applies(true, &responses, true, None, input, Some(&auto)),
                "{input:?}"
            );
            assert!(
                !required_tool_call_applies(true, &responses, true, Some(&[]), input, None),
                "{input:?}"
            );
        }

        // The request already chose.
        for choice in [
            json!("none"),
            json!("required"),
            json!("AUTO"),
            json!({ "type": "function", "name": "exec_command" }),
            Value::Null,
        ] {
            assert!(
                !required_tool_call_applies(
                    true,
                    &responses,
                    true,
                    Some(&tools),
                    &plain_input,
                    Some(&choice)
                ),
                "{choice}"
            );
            assert!(
                !required_tool_call_applies(
                    true,
                    &responses,
                    true,
                    None,
                    &lite_input,
                    Some(&choice)
                ),
                "{choice}"
            );
        }
    }

    #[test]
    fn required_tool_call_applies_only_where_tool_controls_go_upstream() {
        let tool = json!({ "type": "function", "name": "exec_command", "parameters": {} });
        let tools = [tool.clone()];
        let message = json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": "hi" }]
        });
        let lite_input = [
            json!({ "type": "additional_tools", "role": "developer", "tools": [tool] }),
            message.clone(),
        ];
        let plain_input = [message];
        let auto = json!("auto");
        let applies = |credentials: &Credentials| {
            let top_level = required_tool_call_applies(
                true,
                credentials,
                true,
                Some(&tools),
                &plain_input,
                Some(&auto),
            );
            let lite = required_tool_call_applies(true, credentials, true, None, &lite_input, None);
            assert_eq!(top_level, lite, "{}", credentials.endpoint());
            top_level
        };

        // The Responses wire API carries tool controls: the OpenAI API, an
        // OpenAI-compatible Responses endpoint and a ChatGPT login.
        for endpoint in [
            "https://api.openai.com/v1/responses",
            "http://127.0.0.1:8080/v1/responses",
        ] {
            assert!(applies(&api_key(endpoint, None)), "{endpoint}");
        }
        assert!(applies(&chatgpt("gpt-6-luna")));

        // A Chat Completions or Gemini Code Assist request forwards no tool
        // controls, so the proxy neither requires a tool call there nor logs
        // that it does.
        for endpoint in [
            "https://api.openai.com/v1/chat/completions",
            "http://127.0.0.1:8080/v1/chat/completions",
            "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
        ] {
            assert!(!applies(&api_key(endpoint, None)), "{endpoint}");
        }
        assert!(!applies(&Credentials::GeminiCodeAssist {
            access_token: "test".to_string(),
            project_id: "project-1".to_string(),
            endpoint: None,
            default_model: None,
        }));
    }

    #[test]
    fn pinned_lease_filters_tools_carried_in_input_items() {
        // Codex puts its tool list in an `additional_tools` input item for
        // Responses Lite models (the managed one included) and replays
        // client tool search results as `tool_search_output`.
        let function = json!({ "type": "function", "name": "f", "parameters": {} });
        let hosted = json!({ "type": "image_generation", "model": "gpt-image-1" });
        let message = json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": "hi" }],
            "tools": [hosted.clone()]
        });
        let codex_input = vec![
            json!({ "type": "additional_tools", "role": "developer", "tools": [function.clone()] }),
            message.clone(),
        ];
        let (kept, dropped) = input_items_for_pinned_lease(&codex_input);
        assert!(matches!(kept, Cow::Borrowed(_)), "nothing to drop, no copy");
        assert!(dropped.is_empty());

        let hand_built = vec![
            json!({
                "type": "additional_tools",
                "role": "developer",
                "tools": [function.clone(), hosted.clone()]
            }),
            json!({
                "type": "tool_search_output",
                "call_id": "call-1",
                "status": "completed",
                "execution": "client",
                "tools": [hosted.clone(), function.clone()]
            }),
            message.clone(),
        ];
        let (kept, dropped) = input_items_for_pinned_lease(&hand_built);
        assert_eq!(
            kept.into_owned(),
            vec![
                json!({ "type": "additional_tools", "role": "developer", "tools": [function.clone()] }),
                json!({
                    "type": "tool_search_output",
                    "call_id": "call-1",
                    "status": "completed",
                    "execution": "client",
                    "tools": [function]
                }),
                // Only tool-carrying item types are filtered.
                message,
            ]
        );
        assert_eq!(
            dropped
                .iter()
                .map(|tool| (tool.carrier, tool.tool_type.as_str(), tool.reason))
                .collect::<Vec<_>>(),
            vec![
                ("additional_tools", "image_generation", "type"),
                ("tool_search_output", "image_generation", "type"),
            ]
        );
    }

    #[test]
    fn pinned_lease_drops_server_executed_tool_search() {
        // Codex runs its tool search on the client. A tool search with any
        // other execution, or none, asks OpenAI to run it on the platform
        // key, in `tools`, in a tool-carrying input item or in a namespace.
        let tool_search = |execution: Option<&str>| {
            let mut tool = json!({
                "type": "tool_search",
                "description": "Search deferred tools.",
                "parameters": { "type": "object", "properties": {} }
            });
            if let Some(execution) = execution {
                tool["execution"] = json!(execution);
            }
            tool
        };
        let client = tool_search(Some("client"));
        let tools = vec![
            client.clone(),
            tool_search(Some("server")),
            tool_search(Some("Client")),
            tool_search(None),
            json!({ "type": "namespace", "name": "n", "tools": [tool_search(Some("server"))] }),
        ];
        let (kept, dropped) = tools_for_pinned_lease(&tools, "tools");
        assert_eq!(kept, vec![client.clone()]);
        assert_eq!(
            dropped
                .iter()
                .map(|tool| (tool.carrier, tool.tool_type.as_str(), tool.reason))
                .collect::<Vec<_>>(),
            vec![
                ("tools", "tool_search", "hosted"),
                ("tools", "tool_search", "hosted"),
                ("tools", "tool_search", "hosted"),
                ("tools", "namespace", "member"),
            ]
        );

        let input = vec![json!({
            "type": "additional_tools",
            "role": "developer",
            "tools": [client.clone(), tool_search(Some("server"))]
        })];
        let (kept, dropped) = input_items_for_pinned_lease(&input);
        assert_eq!(
            kept.into_owned(),
            vec![json!({ "type": "additional_tools", "role": "developer", "tools": [client] })]
        );
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].reason, "hosted");
    }

    #[test]
    fn a_drop_summary_is_one_bounded_record_however_many_tools_drop() {
        let drop = |carrier, tool_type: &str, reason| DroppedTool {
            carrier,
            tool_type: tool_type.to_string(),
            reason,
        };
        // A flood of one junk type, a few of another, and more distinct groups
        // than one record names.
        let mut dropped: Vec<DroppedTool> = (0..10_000)
            .map(|_| drop("additional_tools", "x", "type"))
            .collect();
        dropped.extend((0..3).map(|_| drop("tools", "image_generation", "type")));
        dropped.extend((0..12).map(|index| drop("tools", &format!("t{index:02}"), "type")));

        let summary = dropped_tools_summary(&dropped);
        assert_eq!(summary["total"], json!(10_015));
        let groups = summary["groups"].as_array().expect("groups");
        assert_eq!(groups.len(), MAX_LOGGED_DROP_GROUPS);
        assert_eq!(
            groups[0],
            json!({ "carrier": "additional_tools", "toolType": "x", "reason": "type", "count": 10_000 })
        );
        assert_eq!(
            groups[1],
            json!({ "carrier": "tools", "toolType": "image_generation", "reason": "type", "count": 3 })
        );
        // 14 distinct groups, 8 named.
        assert_eq!(summary["otherGroups"], json!(6));
        assert!(summary.to_string().len() < 2_048, "{summary}");
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
            job_id: None,
            lease_attempt: None,
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
    fn managed_lease_failure_keeps_the_byoc_rejection_prefix() {
        let error = managed_lease_error(anyhow!("controller credentials returned 404 Not Found"));
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert!(
            error
                .message
                .starts_with("proxy token missing credential_id for BYOC request"),
            "unexpected message: {}",
            error.message
        );
        assert!(error.message.contains("404 Not Found"));
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
