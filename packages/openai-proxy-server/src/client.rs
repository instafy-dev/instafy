use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use reqwest::{StatusCode, Url};
use serde_json::{Map as JsonMap, Value, json};
use uuid::Uuid;

use crate::auth::{Credentials, response_indicates_chatgpt_token_expired};
use crate::upstream_error::{self, ToolControlRejection, UpstreamFailure};

const APPLY_PATCH_GRAMMAR: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../codex/codex-rs/core/assets/tools/apply_patch.lark"
));

/// Last-resort model for requests that carry no model AND resolve against a
/// credential with no default (local/dev auth.json paths). NOT a sentinel:
/// requests that name this id explicitly are served exactly this model.
pub const DEFAULT_MODEL: &str = "gpt-5.5";
pub const DEFAULT_INSTRUCTIONS: &str = include_str!("../prompt_gpt5_codex.md");

#[derive(Debug, Clone)]
pub struct CodexCompletion {
    pub id: String,
    pub model: String,
    pub text: Option<String>,
    pub conversation_id: Option<String>,
    pub raw: Value,
    /// Parsed BYOC subscription-usage snapshot captured from OpenAI's
    /// `x-codex-*` rate-limit response headers (ChatGPT/Codex path only).
    /// `None` for every other provider and whenever no usable window was
    /// present. Serialized shape matches the frontend `subscriptionUsage`
    /// contract; see `parse_codex_rate_limit_headers`.
    pub rate_limits: Option<Value>,
}

/// A policy over the tools one upstream request carries. It gets the final
/// `tools` list, which on a ChatGPT login that requested none is the default
/// tool set this client adds (a Responses Lite request gets none), and
/// returns the tools to send.
pub(crate) type ToolFilter = Box<dyn Fn(&[Value]) -> Vec<Value> + Send + Sync>;

/// Runs once, when a client first sends a request upstream.
pub(crate) type SendHook = Box<dyn FnOnce() + Send + Sync>;

/// Runs once, when a client sends a request again without the
/// `tool_choice: "required"` it set, after upstream refused that choice.
pub(crate) type RequiredToolCallFallbackHook = Box<dyn FnOnce(&ToolControlRejection) + Send + Sync>;

pub struct CodexClient {
    http: reqwest::Client,
    credentials: Credentials,
    conversation_id: Option<String>,
    previous_response_id: Option<String>,
    model: String,
    instructions: String,
    reasoning_effort: Option<String>,
    tools_enabled: bool,
    requested_tools: Option<Vec<Value>>,
    requested_tool_choice: Option<Value>,
    required_tool_call: bool,
    required_tool_call_fallback: Option<RequiredToolCallFallbackHook>,
    required_tool_call_refused: bool,
    requested_parallel_tool_calls: Option<bool>,
    requested_text_controls: Option<Value>,
    tool_filter: Option<ToolFilter>,
    service_tier: Option<Value>,
    service_tier_endpoints: ServiceTierEndpoints,
    send_hook: Option<SendHook>,
    user_agent: String,
}

pub(crate) fn conversation_id_enabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        std::env::var("PROXY_ALLOW_CONVERSATION_ID")
            .ok()
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamWireApi {
    Responses,
    ChatCompletions,
    GeminiCodeAssist,
}

/// The wire API every request with `credentials` goes upstream on.
fn wire_api_for(credentials: &Credentials) -> UpstreamWireApi {
    if credentials.is_chatgpt() {
        UpstreamWireApi::Responses
    } else if credentials.gemini_code_assist_project_id().is_some() {
        UpstreamWireApi::GeminiCodeAssist
    } else {
        detect_upstream_wire_api(credentials.endpoint())
    }
}

/// Whether requests with `credentials` go upstream with the tool controls a
/// client is given, [`CodexClient::with_required_tool_call`] among them:
/// only the Responses wire API carries them, to the OpenAI API or to a
/// ChatGPT login's Codex endpoint. A Chat Completions or Gemini Code Assist
/// request forwards no client tools and no `tool_choice`.
pub(crate) fn sends_tool_controls(credentials: &Credentials) -> bool {
    wire_api_for(credentials) == UpstreamWireApi::Responses
}

/// Whether `item` is the `additional_tools` input item in which codex lists
/// the tools of a Responses Lite model, such as gpt-6-luna, whose request
/// carries no `tools`. It marks the Lite shape whatever tools it holds, none
/// included, as when a pinned lease dropped them all.
pub(crate) fn is_additional_tools_item(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("additional_tools")
}

fn detect_upstream_wire_api(endpoint: &str) -> UpstreamWireApi {
    let normalized = endpoint.trim().to_ascii_lowercase();
    if normalized.contains("cloudcode-pa.googleapis.com")
        || normalized.contains("/v1internal:generatecontent")
    {
        UpstreamWireApi::GeminiCodeAssist
    } else if normalized.contains("/chat/completions") {
        UpstreamWireApi::ChatCompletions
    } else {
        UpstreamWireApi::Responses
    }
}

pub(crate) fn normalize_reasoning_effort(raw: &str) -> Option<String> {
    let effort = raw.trim().to_ascii_lowercase();
    match effort.as_str() {
        "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => Some(effort),
        _ => None,
    }
}

fn global_reasoning_effort() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| match std::env::var("CODEX_REASONING_EFFORT") {
            Ok(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return None;
                }
                let effort = normalize_reasoning_effort(trimmed);
                if effort.is_none() {
                    eprintln!(
                        "[proxy] Ignoring invalid CODEX_REASONING_EFFORT value `{}`; expected minimal|low|medium|high|xhigh|max.",
                        trimmed
                    );
                }
                effort
            }
            Err(_) => None,
        })
        .as_deref()
}

impl CodexClient {
    pub fn new(credentials: Credentials) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .context("failed to create HTTP client")?;

        Ok(Self {
            http,
            credentials,
            conversation_id: None,
            previous_response_id: None,
            model: DEFAULT_MODEL.to_string(),
            instructions: DEFAULT_INSTRUCTIONS.to_string(),
            reasoning_effort: None,
            tools_enabled: true,
            requested_tools: None,
            requested_tool_choice: None,
            required_tool_call: false,
            required_tool_call_fallback: None,
            required_tool_call_refused: false,
            requested_parallel_tool_calls: None,
            requested_text_controls: None,
            tool_filter: None,
            service_tier: None,
            service_tier_endpoints: ServiceTierEndpoints::default(),
            send_hook: None,
            user_agent: format!("openai-proxy-server/{}", env!("CARGO_PKG_VERSION")),
        })
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn with_instructions(mut self, instructions: impl Into<String>) -> Self {
        self.instructions = instructions.into();
        self
    }

    pub fn with_reasoning_effort(mut self, effort: Option<String>) -> Self {
        self.reasoning_effort = effort;
        self
    }

    pub fn with_tools_enabled(mut self, enabled: bool) -> Self {
        self.tools_enabled = enabled;
        self
    }

    pub fn with_response_controls(
        mut self,
        tools: Option<Vec<Value>>,
        tool_choice: Option<Value>,
        parallel_tool_calls: Option<bool>,
        text_controls: Option<Value>,
    ) -> Self {
        self.requested_tools = tools;
        self.requested_tool_choice = tool_choice;
        self.requested_parallel_tool_calls = parallel_tool_calls;
        self.requested_text_controls = text_controls;
        self
    }

    /// Sends `tool_choice: "required"` on the Responses paths, including a
    /// Responses Lite request, whose tools ride in an `additional_tools`
    /// input item and whose own `tool_choice` is otherwise not forwarded. The
    /// proxy sets it only for a request that offers tools and leaves the
    /// choice to the model.
    pub(crate) fn with_required_tool_call(mut self, required: bool) -> Self {
        self.required_tool_call = required;
        self
    }

    /// Runs `hook` when a request that went upstream with the
    /// `tool_choice: "required"` this client set gets a 400 that blames the
    /// tool controls ([`upstream_error::tool_control_rejection`]). The client
    /// then sends the request once more, on the same credentials, as it would
    /// have without the required tool call, and returns what that attempt
    /// gets. No other request is sent again, and the hook runs at most once.
    pub(crate) fn with_required_tool_call_fallback(
        mut self,
        hook: Option<RequiredToolCallFallbackHook>,
    ) -> Self {
        self.required_tool_call_fallback = hook;
        self
    }

    /// Whether upstream refused the `tool_choice: "required"` this client
    /// set, so it sent the request again without it.
    pub(crate) fn required_tool_call_refused(&self) -> bool {
        self.required_tool_call_refused
    }

    /// Runs `filter` over the tools of every request this client sends, after
    /// it adds its default tools, so the filter sees the list that goes
    /// upstream.
    pub(crate) fn with_tool_filter(
        mut self,
        filter: impl Fn(&[Value]) -> Vec<Value> + Send + Sync + 'static,
    ) -> Self {
        self.tool_filter = Some(Box::new(filter));
        self
    }

    /// The `service_tier` every request this client sends carries when
    /// `endpoints` names its upstream endpoint, see [`sends_service_tier`];
    /// a ChatGPT login and Gemini Code Assist get none, and `None` sends
    /// none.
    pub(crate) fn with_service_tier(
        mut self,
        service_tier: Option<Value>,
        endpoints: ServiceTierEndpoints,
    ) -> Self {
        self.service_tier = service_tier;
        self.service_tier_endpoints = endpoints;
        self
    }

    /// Runs `hook` once, as the first request this client sends goes to the
    /// HTTP client, after the checks and payload building that can fail it
    /// inside the proxy; a request that fails before then never runs it.
    pub(crate) fn with_send_hook(mut self, hook: Option<SendHook>) -> Self {
        self.send_hook = hook;
        self
    }

    pub fn with_conversation_state(
        mut self,
        conversation_id: Option<String>,
        previous_response_id: Option<String>,
    ) -> Self {
        self.conversation_id = conversation_id;
        self.previous_response_id = previous_response_id;
        self
    }

    pub async fn complete(&mut self, prompt: &str) -> Result<CodexCompletion> {
        let trimmed = prompt.trim();
        if trimmed.is_empty() {
            bail!("prompt must not be empty");
        }

        let input_items = vec![json!({
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": trimmed,
                }
            ],
        })];

        self.complete_with_input(&input_items).await
    }

    pub async fn complete_with_input(&mut self, input_items: &[Value]) -> Result<CodexCompletion> {
        if input_items.is_empty() {
            bail!("request must include at least one input item");
        }

        let mut headers = HeaderMap::new();
        let allow_conversation = conversation_id_enabled();
        let mut conversation_id_for_request = if allow_conversation {
            self.conversation_id.clone()
        } else {
            None
        };
        let upstream_wire_api = wire_api_for(&self.credentials);
        headers.insert(USER_AGENT, HeaderValue::from_str(&self.user_agent)?);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if self.credentials.is_chatgpt() {
            if allow_conversation {
                let header_conversation_id = conversation_id_for_request
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                conversation_id_for_request = Some(header_conversation_id.clone());
                headers.insert(
                    HeaderName::from_static("conversation-id"),
                    HeaderValue::from_str(&header_conversation_id)?,
                );
                headers.insert(
                    HeaderName::from_static("session-id"),
                    HeaderValue::from_str(&header_conversation_id)?,
                );
                if let Ok(name) = HeaderName::from_bytes(b"session_id") {
                    headers.insert(name, HeaderValue::from_str(&header_conversation_id)?);
                }
            }
            headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
            headers.insert(
                HeaderName::from_static("openai-beta"),
                HeaderValue::from_static("responses=experimental"),
            );
        } else {
            if upstream_wire_api == UpstreamWireApi::Responses {
                headers.insert(
                    HeaderName::from_static("openai-beta"),
                    HeaderValue::from_static("responses=v1"),
                );
            }
        }

        let (payload, request_id_header) = self.upstream_payload(
            input_items,
            conversation_id_for_request.as_deref(),
            upstream_wire_api,
            self.required_tool_call,
        )?;

        if upstream_wire_api == UpstreamWireApi::GeminiCodeAssist {
            headers.insert(
                HeaderName::from_static("x-goog-api-client"),
                HeaderValue::from_static("gl-node/22.17.0"),
            );
            headers.insert(
                HeaderName::from_static("client-metadata"),
                HeaderValue::from_static(
                    "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
                ),
            );
            if let Some(request_id) = request_id_header.as_deref() {
                headers.insert(
                    HeaderName::from_static("x-activity-request-id"),
                    HeaderValue::from_str(request_id)?,
                );
            }
        }

        debug_http_request(self.credentials.endpoint(), &headers, &payload);

        let request_url = if upstream_wire_api == UpstreamWireApi::GeminiCodeAssist {
            gemini_code_assist_request_url(self.credentials.endpoint())
        } else {
            self.credentials.endpoint().to_string()
        };

        if let Some(send_hook) = self.send_hook.take() {
            send_hook();
        }
        let response = match self
            .send_upstream_request_with_retry(request_url.as_str(), &headers, &payload)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // Only a `required` this client set itself falls back: a
                // request that chose `required` keeps its own failure.
                let rejection = if self.required_tool_call
                    && payload.get("tool_choice").and_then(Value::as_str) == Some("required")
                {
                    upstream_error::tool_control_rejection(&error).cloned()
                } else {
                    None
                };
                let Some(rejection) = rejection else {
                    return Err(error);
                };
                let (fallback, _) = self.upstream_payload(
                    input_items,
                    conversation_id_for_request.as_deref(),
                    upstream_wire_api,
                    false,
                )?;
                self.required_tool_call = false;
                self.required_tool_call_refused = true;
                if let Some(hook) = self.required_tool_call_fallback.take() {
                    hook(&rejection);
                }
                debug_http_request(self.credentials.endpoint(), &headers, &fallback);
                // A second failure goes back as any failure does.
                self.send_upstream_request_with_retry(request_url.as_str(), &headers, &fallback)
                    .await?
            }
        };

        // Capture the subscription-usage snapshot from OpenAI's `x-codex-*`
        // rate-limit headers before the body is consumed below. This is the
        // only point where the upstream response headers are still available.
        // ChatGPT/Codex path only; other providers do not emit these headers.
        // Parsing never fails, so this stays strictly non-breaking.
        let rate_limits = if self.credentials.is_chatgpt() {
            parse_codex_rate_limit_headers(response.headers())
        } else {
            None
        };

        if self.credentials.is_chatgpt() {
            let body = read_chatgpt_stream(response).await?;
            let mut completion =
                parse_completion(body).context(UpstreamFailure::InvalidResponse)?;
            completion.rate_limits = rate_limits;
            return Ok(completion);
        }

        let body: Value = response
            .json()
            .await
            .context("failed to decode JSON response")?;
        let mut completion = match upstream_wire_api {
            UpstreamWireApi::Responses => {
                parse_completion(body).context(UpstreamFailure::InvalidResponse)?
            }
            UpstreamWireApi::ChatCompletions => {
                let adapted = chat_completions_to_responses(body)
                    .context(UpstreamFailure::InvalidResponse)?;
                parse_completion(adapted).context(UpstreamFailure::InvalidResponse)?
            }
            UpstreamWireApi::GeminiCodeAssist => {
                let adapted = gemini_code_assist_to_responses(body, &self.model)
                    .context(UpstreamFailure::InvalidResponse)?;
                parse_completion(adapted).context(UpstreamFailure::InvalidResponse)?
            }
        };
        completion.rate_limits = rate_limits;
        Ok(completion)
    }

    /// The body one request goes upstream with on `upstream_wire_api`, after
    /// the tool filter and the service tier, with `tool_choice: "required"`
    /// where the builders send a tool control and `required_tool_call` holds.
    /// Also returns the request id a Gemini Code Assist request carries.
    fn upstream_payload(
        &self,
        input_items: &[Value],
        conversation_id: Option<&str>,
        upstream_wire_api: UpstreamWireApi,
        required_tool_call: bool,
    ) -> Result<(Value, Option<String>)> {
        let previous_response_id = if conversation_id_enabled() {
            self.previous_response_id.as_deref()
        } else {
            None
        };

        let mut request_id_header: Option<String> = None;
        let mut payload = if self.credentials.is_chatgpt() {
            build_chatgpt_payload(
                &self.model,
                &self.instructions,
                input_items,
                conversation_id,
                previous_response_id,
                self.reasoning_effort.as_deref(),
                self.tools_enabled,
                self.requested_tools.as_deref(),
                self.requested_tool_choice.as_ref(),
                required_tool_call,
                self.requested_parallel_tool_calls,
                self.requested_text_controls.as_ref(),
            )
        } else {
            match upstream_wire_api {
                UpstreamWireApi::Responses => build_openai_payload(
                    &self.model,
                    &self.instructions,
                    input_items,
                    conversation_id,
                    self.previous_response_id.as_deref(),
                    self.reasoning_effort.as_deref(),
                    self.tools_enabled,
                    self.requested_tools.as_deref(),
                    self.requested_tool_choice.as_ref(),
                    required_tool_call,
                    self.requested_parallel_tool_calls,
                    self.requested_text_controls.as_ref(),
                ),
                UpstreamWireApi::ChatCompletions => build_openai_chat_completions_payload(
                    &self.model,
                    &self.instructions,
                    input_items,
                    self.reasoning_effort.as_deref(),
                )?,
                UpstreamWireApi::GeminiCodeAssist => {
                    let (payload, request_id) = build_gemini_code_assist_payload(
                        &self.model,
                        &self.instructions,
                        input_items,
                        self.credentials.gemini_code_assist_project_id(),
                        conversation_id,
                    )?;
                    request_id_header = Some(request_id);
                    payload
                }
            }
        };
        if let Some(filter) = self.tool_filter.as_deref() {
            filter_payload_tools(&mut payload, filter);
        }
        set_payload_service_tier(
            &mut payload,
            &self.credentials,
            upstream_wire_api,
            self.service_tier.as_ref(),
            self.service_tier_endpoints,
        );
        Ok((payload, request_id_header))
    }

    async fn send_upstream_request_with_retry(
        &mut self,
        request_url: &str,
        headers: &HeaderMap,
        payload: &Value,
    ) -> Result<reqwest::Response> {
        let _ = self
            .credentials
            .reload_chatgpt_access_token_from_auth_path();

        let mut response = self
            .send_upstream_request(request_url, headers, payload)
            .await?;

        if response.status() == StatusCode::UNAUTHORIZED && self.credentials.is_chatgpt() {
            let response_headers = response.headers().clone();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<empty>".to_string());
            if response_indicates_chatgpt_token_expired(StatusCode::UNAUTHORIZED, &body)
                && self
                    .credentials
                    .refresh_chatgpt_access_token(&self.http)
                    .await
                    .context(UpstreamFailure::CredentialRefresh)?
            {
                response = self
                    .send_upstream_request(request_url, headers, payload)
                    .await?;
            } else {
                return Err(UpstreamFailure::http_body(
                    StatusCode::UNAUTHORIZED,
                    &response_headers,
                    &body,
                )
                .into());
            }
        }

        if !response.status().is_success() {
            let status = response.status();
            let response_headers = response.headers().clone();
            let text = response
                .text()
                .await
                .unwrap_or_else(|_| "<empty>".to_string());
            return Err(UpstreamFailure::http_body(status, &response_headers, &text).into());
        }

        Ok(response)
    }

    async fn send_upstream_request(
        &self,
        request_url: &str,
        headers: &HeaderMap,
        payload: &Value,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .http
            .post(request_url)
            .headers(headers.clone())
            .bearer_auth(self.credentials.bearer())
            .json(payload);

        if let Some(account_id) = self.credentials.chatgpt_account_id() {
            request = request.header("ChatGPT-Account-Id", account_id);
        }

        request.send().await.context("failed to send request")
    }
}

/// Prints a request about to go upstream when `CODEX_DEBUG_HTTP=1`.
fn debug_http_request(endpoint: &str, headers: &HeaderMap, payload: &Value) {
    if std::env::var("CODEX_DEBUG_HTTP").as_deref() == Ok("1") {
        eprintln!(
            "--> POST {}\nHeaders: {:?}\nBody: {}",
            endpoint,
            headers,
            serde_json::to_string_pretty(payload).unwrap_or_default()
        );
    }
}

fn build_openai_payload(
    model: &str,
    instructions: &str,
    input_items: &[Value],
    conversation_id: Option<&str>,
    previous_response_id: Option<&str>,
    requested_reasoning_effort: Option<&str>,
    tools_enabled: bool,
    requested_tools: Option<&[Value]>,
    requested_tool_choice: Option<&Value>,
    required_tool_call: bool,
    requested_parallel_tool_calls: Option<bool>,
    requested_text_controls: Option<&Value>,
) -> Value {
    let mut payload = json!({
        "model": model,
        "instructions": instructions,
        "input": input_items,
        "stream": false,
        "metadata": {}
    });

    if conversation_id_enabled() {
        if let Some(conv) = conversation_id {
            payload["conversation_id"] = Value::String(conv.to_string());
        }
        if let Some(previous) = previous_response_id {
            payload["previous_response_id"] = Value::String(previous.to_string());
        }
    }

    if let Some(effort) = requested_reasoning_effort.or_else(|| global_reasoning_effort()) {
        payload["reasoning"] = json!({
            "effort": effort,
            "summary": "auto"
        });
    }

    if tools_enabled && let Some(tools) = requested_tools.filter(|tools| !tools.is_empty()) {
        payload["tools"] = Value::Array(tools.to_vec());
        payload["tool_choice"] = tool_choice_to_send(requested_tool_choice, required_tool_call);
        payload["parallel_tool_calls"] =
            Value::Bool(requested_parallel_tool_calls.unwrap_or(false));
    } else if tools_enabled {
        // Responses Lite: the tools ride in an `additional_tools` input item
        // and `tools` is empty, so only a required tool call sends a tool
        // choice. The request's own `tool_choice` is not forwarded. Its own
        // `parallel_tool_calls` is, when it sent a boolean: codex sends such a
        // model `false`, and the OpenAI API's default is `true`.
        if required_tool_call {
            payload["tool_choice"] = json!("required");
        }
        if let Some(parallel_tool_calls) = requested_parallel_tool_calls
            && input_items.iter().any(is_additional_tools_item)
        {
            payload["parallel_tool_calls"] = Value::Bool(parallel_tool_calls);
        }
    }

    if let Some(text_controls) = requested_text_controls
        && !text_controls.is_null()
    {
        payload["text"] = text_controls.clone();
    }

    payload
}

/// The `tool_choice` a request goes upstream with where the builders send
/// one: `"required"` when the proxy requires a tool call, otherwise the
/// requested choice, `"auto"` when there is none.
fn tool_choice_to_send(requested_tool_choice: Option<&Value>, required_tool_call: bool) -> Value {
    if required_tool_call {
        json!("required")
    } else {
        requested_tool_choice
            .cloned()
            .unwrap_or_else(|| json!("auto"))
    }
}

fn build_openai_chat_completions_payload(
    model: &str,
    instructions: &str,
    input_items: &[Value],
    requested_reasoning_effort: Option<&str>,
) -> Result<Value> {
    let mut messages = Vec::new();
    let instructions_text = instructions.trim();
    if !instructions_text.is_empty() {
        messages.push(json!({
            "role": "system",
            "content": instructions_text,
        }));
    }

    for item in input_items {
        let Some(role) = item.get("role").and_then(Value::as_str) else {
            continue;
        };

        let Some(content_items) = item.get("content").and_then(Value::as_array) else {
            continue;
        };

        let mut parts = Vec::new();
        for part in content_items {
            let Some(obj) = part.as_object() else {
                continue;
            };

            let kind = obj
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            if kind != "input_text" && kind != "output_text" {
                continue;
            }

            if let Some(text) = obj.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }

        let joined = parts.join("\n");
        if joined.trim().is_empty() {
            continue;
        }

        messages.push(json!({
            "role": role,
            "content": joined,
        }));
    }

    if messages.is_empty() {
        bail!("chat completions payload is missing messages");
    }

    let mut payload = json!({
        "model": model,
        "messages": messages,
        "stream": false,
        // Keep this high enough that providers with separate reasoning fields still return visible output.
        "max_tokens": 1024,
    });
    if let Some(effort) = requested_reasoning_effort.or_else(|| global_reasoning_effort()) {
        payload["reasoning_effort"] = json!(effort);
    }
    Ok(payload)
}

fn build_gemini_code_assist_payload(
    model: &str,
    instructions: &str,
    input_items: &[Value],
    project_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<(Value, String)> {
    let project_id = project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("gemini code assist credential missing project id"))?;

    let mut contents = Vec::new();
    for item in input_items {
        let role = item
            .get("role")
            .and_then(Value::as_str)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("user");

        let Some(content_items) = item.get("content").and_then(Value::as_array) else {
            continue;
        };

        let text = content_items
            .iter()
            .filter_map(|part| {
                let kind = part
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|value| value.trim().to_ascii_lowercase())
                    .unwrap_or_default();
                if kind != "input_text" && kind != "output_text" {
                    return None;
                }
                part.get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            continue;
        }

        let mapped_role = if role.eq_ignore_ascii_case("assistant") {
            "model"
        } else {
            "user"
        };

        contents.push(json!({
            "role": mapped_role,
            "parts": [{ "text": text }],
        }));
    }

    if contents.is_empty() {
        bail!("gemini code assist payload is missing contents");
    }

    let request_id = Uuid::new_v4().to_string();
    let session_id = conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let mut request_payload = JsonMap::new();
    request_payload.insert("contents".to_string(), Value::Array(contents));
    request_payload.insert("session_id".to_string(), Value::String(session_id));

    let instructions_text = instructions.trim();
    if !instructions_text.is_empty() {
        request_payload.insert(
            "systemInstruction".to_string(),
            json!({ "parts": [{ "text": instructions_text }] }),
        );
    }

    Ok((
        json!({
            "project": project_id,
            "model": model,
            "user_prompt_id": request_id,
            "request": Value::Object(request_payload),
        }),
        request_id,
    ))
}

fn gemini_code_assist_request_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.contains("/v1internal:") {
        return trimmed.to_string();
    }
    format!("{trimmed}/v1internal:generateContent")
}

fn build_chatgpt_payload(
    model: &str,
    instructions: &str,
    input_items: &[Value],
    conversation_id: Option<&str>,
    previous_response_id: Option<&str>,
    requested_reasoning_effort: Option<&str>,
    tools_enabled: bool,
    requested_tools: Option<&[Value]>,
    requested_tool_choice: Option<&Value>,
    required_tool_call: bool,
    requested_parallel_tool_calls: Option<bool>,
    requested_text_controls: Option<&Value>,
) -> Value {
    let reasoning_effort = requested_reasoning_effort
        .or_else(|| global_reasoning_effort())
        .unwrap_or("medium");

    let mut payload = json!({
        "model": model,
        "instructions": instructions.trim(),
        "input": input_items,
        "reasoning": {
            "effort": reasoning_effort,
            "summary": "auto"
        },
        "store": false,
        "stream": true,
        "include": [],
        "text": serde_json::Value::Null
    });

    if tools_enabled && let Some(tools) = requested_tools.filter(|tools| !tools.is_empty()) {
        payload["tools"] = Value::Array(tools.to_vec());
        payload["tool_choice"] = tool_choice_to_send(requested_tool_choice, required_tool_call);
        payload["parallel_tool_calls"] =
            Value::Bool(requested_parallel_tool_calls.unwrap_or(false));
    } else if tools_enabled {
        // The request's own `tool_choice` is not forwarded with the default
        // tools; a Responses Lite request that requires a tool call, whose
        // tools ride in an `additional_tools` input item, gets `"required"`.
        // A Responses Lite request gets none of the default tools: the
        // runtime offers the model only the tools in its item, even one a
        // pinned lease left empty, never these. Its tool controls stay.
        let tool_metadata = resolve_chatgpt_tools(model);
        if !input_items.iter().any(is_additional_tools_item) {
            payload["tools"] = Value::Array(tool_metadata.tools);
        }
        payload["tool_choice"] = tool_choice_to_send(None, required_tool_call);
        payload["parallel_tool_calls"] = Value::Bool(tool_metadata.parallel_tool_calls);
    }

    if let Some(text_controls) = requested_text_controls
        && !text_controls.is_null()
    {
        payload["text"] = text_controls.clone();
    }

    if conversation_id_enabled() {
        if let Some(conv) = conversation_id {
            payload["conversation_id"] = Value::String(conv.to_string());
            payload["prompt_cache_key"] = Value::String(conv.to_string());
        }
        if let Some(previous) = previous_response_id {
            payload["previous_response_id"] = Value::String(previous.to_string());
        }
    }

    payload
}

fn chat_completions_to_responses(raw: Value) -> Result<Value> {
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("resp-{}", Uuid::new_v4()));

    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let message = raw
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("chat completions response missing choices[0].message"))?;

    let content = message
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    let assistant_text = if !content.is_empty() {
        content.to_string()
    } else if let Some(reasoning) = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        reasoning.to_string()
    } else {
        bail!("chat completions response missing assistant content");
    };

    let usage = raw.get("usage").and_then(Value::as_object);
    let prompt_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(number_to_u64)
        .unwrap_or(0);
    let completion_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(number_to_u64)
        .unwrap_or(0);
    let total_tokens = usage
        .and_then(|u| u.get("total_tokens"))
        .and_then(number_to_u64)
        .unwrap_or(prompt_tokens + completion_tokens);

    Ok(json!({
        "id": id,
        "model": model,
        "output": [
            {
                "id": format!("msg_{}", Uuid::new_v4()),
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": assistant_text,
                    }
                ]
            }
        ],
        "usage": {
            "input_tokens": prompt_tokens,
            "output_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "input_tokens_details": { "cached_tokens": 0 },
            "output_tokens_details": { "reasoning_tokens": 0 }
        }
    }))
}

fn gemini_code_assist_to_responses(raw: Value, fallback_model: &str) -> Result<Value> {
    let trace_id = raw
        .get("traceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let inner = raw.get("response").cloned().unwrap_or(raw);
    let inner_obj = inner
        .as_object()
        .ok_or_else(|| anyhow!("Gemini Code Assist response is not an object"))?;

    let response_id = inner_obj
        .get("responseId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or(trace_id)
        .unwrap_or_else(|| format!("resp-{}", Uuid::new_v4()));

    let model = inner_obj
        .get("modelVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            inner_obj
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(fallback_model)
        .to_string();

    let assistant_text = extract_gemini_candidate_text(&inner)
        .ok_or_else(|| anyhow!("Gemini Code Assist response missing candidate text"))?;

    let usage = inner_obj
        .get("usageMetadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let prompt_tokens = usage
        .get("promptTokenCount")
        .and_then(number_to_u64)
        .unwrap_or(0);
    let completion_tokens = usage
        .get("candidatesTokenCount")
        .and_then(number_to_u64)
        .unwrap_or(0);
    let total_tokens = usage
        .get("totalTokenCount")
        .and_then(number_to_u64)
        .unwrap_or(prompt_tokens + completion_tokens);

    Ok(json!({
        "id": response_id,
        "model": model,
        "output": [
            {
                "id": format!("msg_{}", Uuid::new_v4()),
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": assistant_text,
                    }
                ]
            }
        ],
        "usage": {
            "input_tokens": prompt_tokens,
            "output_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "input_tokens_details": { "cached_tokens": 0 },
            "output_tokens_details": { "reasoning_tokens": 0 }
        }
    }))
}

fn extract_gemini_candidate_text(inner: &Value) -> Option<String> {
    let candidates = inner.get("candidates")?.as_array()?;
    let first = candidates.first()?;
    let content = first.get("content")?.as_object()?;
    let parts = content.get("parts")?.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
        })
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
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

/// Runs a [`ToolFilter`] over the `tools` a built payload carries. A payload
/// left with no tools also loses `tool_choice` and `parallel_tool_calls`, the
/// shape the builders give a request that carries none.
fn filter_payload_tools(
    payload: &mut Value,
    filter: &(dyn Fn(&[Value]) -> Vec<Value> + Send + Sync),
) {
    let Some(tools) = payload.get("tools").and_then(Value::as_array) else {
        return;
    };
    let kept = filter(tools);
    if !kept.is_empty() {
        payload["tools"] = Value::Array(kept);
    } else if let Some(payload) = payload.as_object_mut() {
        for key in ["tools", "tool_choice", "parallel_tool_calls"] {
            payload.remove(key);
        }
    }
}

/// Which upstream endpoints get the `service_tier` a client is given with
/// [`CodexClient::with_service_tier`]: the proxy's
/// `PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS` setting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ServiceTierEndpoints {
    /// `openai`, the default: only the OpenAI API, an endpoint whose host is
    /// under `openai.com`, such as `api.openai.com`. An OpenAI-compatible
    /// provider may reject the field or its value (Groq, for one, names its
    /// tiers differently), so any other host gets none.
    #[default]
    OpenAi,
    /// `all`: every endpoint that takes a tier, for an OpenAI-compatible
    /// provider that accepts `default`.
    All,
    /// `none`: no endpoint.
    Never,
}

impl ServiceTierEndpoints {
    /// The environment variable the proxy reads the setting from.
    pub(crate) const ENV: &'static str = "PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS";

    /// Reads the setting, ignoring case and surrounding whitespace; unset or
    /// empty is `openai`. Any other value is an error, so the proxy refuses
    /// to start rather than guess where the tier goes.
    pub(crate) fn parse(raw: Option<&str>) -> Result<Self> {
        let Some(raw) = raw
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
        else {
            return Ok(Self::default());
        };
        match raw.as_str() {
            "openai" => Ok(Self::OpenAi),
            "all" => Ok(Self::All),
            "none" => Ok(Self::Never),
            _ => bail!("{} must be openai, all or none", Self::ENV),
        }
    }

    /// Whether a request to `endpoint` gets the tier, when its credentials
    /// and wire API take one.
    fn include(self, endpoint: &str) -> bool {
        match self {
            Self::OpenAi => is_openai_api_endpoint(endpoint),
            Self::All => true,
            Self::Never => false,
        }
    }
}

/// Whether `endpoint` is the OpenAI API: its host, as the URL parser reads
/// it, is a domain under `openai.com`, in any case, with or without a
/// trailing dot. A userinfo, path, query or fragment that names an OpenAI
/// host does not count, and neither does an IP address or a URL that does
/// not parse.
fn is_openai_api_endpoint(endpoint: &str) -> bool {
    let Some(host) = Url::parse(endpoint)
        .ok()
        .and_then(|url| url.domain().map(str::to_ascii_lowercase))
    else {
        return false;
    };
    host.strip_suffix('.')
        .unwrap_or(&host)
        .ends_with(".openai.com")
}

/// Whether a request with `credentials` on `wire_api` takes a
/// `service_tier`: only Responses and Chat Completions requests do, both at
/// the top level, and only to an endpoint `endpoints` names. A ChatGPT login
/// takes none: the proxy has never sent the ChatGPT Codex endpoint a tier,
/// codex itself sends it no `default`, and how that endpoint treats one is
/// unverified. A Gemini Code Assist request has no service tier either.
fn takes_service_tier(
    credentials: &Credentials,
    wire_api: UpstreamWireApi,
    endpoints: ServiceTierEndpoints,
) -> bool {
    !credentials.is_chatgpt()
        && wire_api != UpstreamWireApi::GeminiCodeAssist
        && endpoints.include(credentials.endpoint())
}

/// Whether requests with `credentials` carry the tier a client is given
/// with [`CodexClient::with_service_tier`] under `endpoints`.
pub(crate) fn sends_service_tier(
    credentials: &Credentials,
    endpoints: ServiceTierEndpoints,
) -> bool {
    takes_service_tier(credentials, wire_api_for(credentials), endpoints)
}

/// Puts `service_tier` on a payload that takes one, see
/// [`takes_service_tier`].
fn set_payload_service_tier(
    payload: &mut Value,
    credentials: &Credentials,
    wire_api: UpstreamWireApi,
    service_tier: Option<&Value>,
    endpoints: ServiceTierEndpoints,
) {
    if let Some(service_tier) = service_tier
        && takes_service_tier(credentials, wire_api, endpoints)
    {
        payload["service_tier"] = service_tier.clone();
    }
}

struct ChatGptToolMetadata {
    tools: Vec<Value>,
    parallel_tool_calls: bool,
}

fn resolve_chatgpt_tools(_model: &str) -> ChatGptToolMetadata {
    let mut tools = Vec::new();
    tools.push(shell_tool_spec());
    if truthy_env_flag("CODEX_INCLUDE_APPLY_PATCH_TOOL").unwrap_or(true) {
        tools.push(apply_patch_tool_spec());
    }

    if truthy_env_flag("CODEX_INCLUDE_PLAN_TOOL").unwrap_or(true) {
        tools.push(plan_tool_spec());
    }

    if truthy_env_flag("CODEX_ENABLE_WEB_SEARCH").unwrap_or(false) {
        tools.push(web_search_tool_spec());
    }

    if truthy_env_flag("CODEX_INCLUDE_VIEW_IMAGE_TOOL").unwrap_or(true) {
        tools.push(view_image_tool_spec());
    }

    ChatGptToolMetadata {
        tools,
        parallel_tool_calls: false,
    }
}

fn truthy_env_flag(key: &str) -> Option<bool> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .and_then(|value| match value.as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
}

fn shell_tool_spec() -> Value {
    json!({
        "type": "function",
        "name": "shell",
        "description": "Runs a shell command and returns its output.",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "array",
                    "description": "The command to execute",
                    "items": { "type": "string" }
                },
                "workdir": {
                    "type": "string",
                    "description": "The working directory to execute the command in"
                },
                "timeout_ms": {
                    "type": "number",
                    "description": "The timeout for the command in milliseconds"
                },
                "with_escalated_permissions": {
                    "type": "boolean",
                    "description": "Whether to request escalated permissions. Set to true if command needs to be run without sandbox restrictions"
                },
                "justification": {
                    "type": "string",
                    "description": "Only set if with_escalated_permissions is true. 1-sentence explanation of why we want to run this command."
                }
            },
            "required": ["command"],
            "additionalProperties": false
        }
    })
}

fn apply_patch_tool_spec() -> Value {
    json!({
        "type": "custom",
        "name": "apply_patch",
        "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": APPLY_PATCH_GRAMMAR,
        }
    })
}

fn plan_tool_spec() -> Value {
    json!({
        "type": "function",
        "name": "update_plan",
        "description": "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "explanation": { "type": "string" },
                "plan": {
                    "type": "array",
                    "description": "The list of steps",
                    "items": {
                        "type": "object",
                        "properties": {
                            "step": { "type": "string" },
                            "status": {
                                "type": "string",
                                "description": "One of: pending, in_progress, completed"
                            }
                        },
                        "required": ["step", "status"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["plan"],
            "additionalProperties": false
        }
    })
}

fn web_search_tool_spec() -> Value {
    json!({
        "type": "web_search"
    })
}

fn view_image_tool_spec() -> Value {
    json!({
        "type": "function",
        "name": "view_image",
        "description": "Attach a local image (by filesystem path) to the conversation context for this turn.",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Local filesystem path to an image file"
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

async fn read_chatgpt_stream(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("failed to read streaming chunk from backend")?
    {
        bytes.extend_from_slice(&chunk);
    }

    let text = String::from_utf8(bytes).context("streamed response was not valid UTF-8")?;

    if std::env::var("CODEX_DEBUG_HTTP").as_deref() == Ok("1") {
        eprintln!("<-- stream\n{}", text);
    }

    read_chatgpt_stream_text(&text)
}

fn read_chatgpt_stream_text(text: &str) -> Result<Value> {
    let mut completed: Option<Value> = None;
    let mut incomplete: Option<Value> = None;
    let mut assistant_text_delta = String::new();
    let mut completed_output_items = Vec::new();
    let mut event_kind: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if process_chatgpt_stream_event(
                event_kind.as_deref(),
                &data_lines,
                &mut completed,
                &mut incomplete,
                &mut completed_output_items,
                &mut assistant_text_delta,
            )? {
                break;
            }
            event_kind = None;
            data_lines.clear();
            continue;
        }

        if let Some(event) = trimmed.strip_prefix("event:") {
            event_kind = Some(event.trim().to_string());
            continue;
        };

        if let Some(data) = trimmed.strip_prefix("data:") {
            data_lines.push(data.trim().to_string());
        }
    }

    if !data_lines.is_empty() {
        process_chatgpt_stream_event(
            event_kind.as_deref(),
            &data_lines,
            &mut completed,
            &mut incomplete,
            &mut completed_output_items,
            &mut assistant_text_delta,
        )?;
    }

    if let Some(mut completed) = completed {
        backfill_chatgpt_completed_output(
            &mut completed,
            completed_output_items,
            assistant_text_delta.trim_end_matches('\n'),
        );
        return Ok(completed);
    }

    // The upstream stopped the response early and has billed it. It is returned with
    // `status: "incomplete"`, like the API's own response, for the proxy to decide what the
    // client gets (see `incomplete_response`). Its output gets only the items the stream
    // finished: an item that was only added, and text that only streamed as deltas, were cut
    // off, so neither is backfilled.
    let mut incomplete =
        incomplete.ok_or_else(|| anyhow!("stream ended without a response.completed event"))?;
    let finished_output_items = completed_output_items
        .into_iter()
        .filter(|streamed| streamed.done)
        .collect();
    backfill_chatgpt_completed_output(&mut incomplete, finished_output_items, "");
    if let Value::Object(map) = &mut incomplete {
        map.insert("status".to_string(), json!("incomplete"));
    }
    Ok(incomplete)
}

#[derive(Debug)]
struct StreamedOutputItem {
    output_index: Option<usize>,
    item: Value,
    /// Whether the item came from `response.output_item.done`, so the upstream finished it.
    done: bool,
}

impl StreamedOutputItem {
    fn from_event(event: &Value, item: Value, done: bool) -> Self {
        Self {
            output_index: event
                .get("output_index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok()),
            item,
            done,
        }
    }
}

fn process_chatgpt_stream_event(
    event_kind: Option<&str>,
    data_lines: &[String],
    completed: &mut Option<Value>,
    incomplete: &mut Option<Value>,
    completed_output_items: &mut Vec<StreamedOutputItem>,
    assistant_text_delta: &mut String,
) -> Result<bool> {
    if data_lines.is_empty() {
        return Ok(false);
    }

    let payload = data_lines.join("\n");
    if payload.trim() == "[DONE]" {
        return Ok(true);
    }

    let event: Value = serde_json::from_str(&payload)
        .with_context(|| format!("failed to parse stream event JSON: {}", payload))?;
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .or(event_kind)
        .unwrap_or("");

    match kind {
        // The backend reports a terminal stream failure as `response.failed`
        // carrying `response.error`, and answers HTTP 200 while doing it: a
        // quota exhaustion arrives here, not as a 429. `response.error` is
        // kept because older captures use it, but it is not what the backend
        // sends today, so handling only that name dropped the payload and let
        // the stream end without `response.completed` -- surfacing as "stream
        // ended without a response.completed event", which is indistinguishable
        // from a truncated stream or a parser regression. The machine-readable
        // `code` (e.g. `insufficient_quota`) is what makes the difference
        // between a quota wall and a bug legible at a glance.
        "response.failed" | "response.error" => {
            let error = event
                .get("error")
                .or_else(|| event.get("response").and_then(|r| r.get("error")));
            let message = error
                .and_then(|err| err.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            let code = error
                .and_then(|err| err.get("code"))
                .and_then(Value::as_str);
            return Err(UpstreamFailure::Stream {
                code: code.map(str::to_string),
                message: message.to_string(),
            }
            .into());
        }
        "response.output_text.delta" => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                assistant_text_delta.push_str(delta);
            }
        }
        "response.output_text.done" => {
            if let Some(text) = event.get("text").and_then(Value::as_str)
                && !text.trim().is_empty()
                && assistant_text_delta.trim().is_empty()
            {
                assistant_text_delta.push_str(text);
            }
        }
        "response.output_item.added" => {
            if let Some(item) = event.get("item")
                && response_item_has_assistant_output_text(item)
            {
                completed_output_items.push(StreamedOutputItem::from_event(
                    &event,
                    item.clone(),
                    false,
                ));
            }
        }
        "response.output_item.done" => {
            if let Some(item) = event.get("item")
                && response_item_should_be_preserved(item)
            {
                completed_output_items.push(StreamedOutputItem::from_event(
                    &event,
                    item.clone(),
                    true,
                ));
            }
        }
        "message" => {
            if let Some(item) = chatgpt_message_event_to_response_item(&event) {
                completed_output_items.push(StreamedOutputItem::from_event(&event, item, false));
            }
        }
        "response.completed" => {
            if let Some(response) = event.get("response") {
                *completed = Some(response.clone());
            } else if event.get("id").is_some() && event.get("status").is_some() {
                *completed = Some(event);
            }
        }
        // The upstream stopped the response early, at `max_output_tokens` or by a content
        // filter for example. It is still a response, with the usage it was billed for, not a
        // stream failure.
        "response.incomplete" => {
            if let Some(response) = event.get("response") {
                *incomplete = Some(response.clone());
            } else if event.get("id").is_some() && event.get("status").is_some() {
                *incomplete = Some(event);
            }
        }
        _ => {}
    }

    Ok(false)
}

fn backfill_chatgpt_completed_output(
    completed: &mut Value,
    completed_output_items: Vec<StreamedOutputItem>,
    assistant_text_delta: &str,
) {
    let Value::Object(map) = completed else {
        return;
    };

    let mut output = map
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut streamed_output_items = Vec::<StreamedOutputItem>::new();
    for mut streamed in completed_output_items {
        if let Some(existing) = streamed_output_items
            .iter_mut()
            .find(|existing| response_items_match(&existing.item, &streamed.item))
        {
            if streamed.output_index.is_none() {
                streamed.output_index = existing.output_index;
            }
            *existing = streamed;
        } else {
            streamed_output_items.push(streamed);
        }
    }
    streamed_output_items.sort_by_key(|streamed| streamed.output_index.unwrap_or(usize::MAX));

    for streamed in streamed_output_items {
        if let Some(existing_index) = output
            .iter()
            .position(|existing| response_items_match(existing, &streamed.item))
        {
            if let Some(output_index) = streamed.output_index {
                let existing = output.remove(existing_index);
                output.insert(output_index.min(output.len()), existing);
            }
            continue;
        }

        let output_index = streamed
            .output_index
            .unwrap_or(output.len())
            .min(output.len());
        output.insert(output_index, streamed.item);
    }

    if !output.iter().any(response_item_has_assistant_output_text)
        && !assistant_text_delta.trim().is_empty()
    {
        output.push(assistant_text_response_item(assistant_text_delta));
    }

    if !output.is_empty() {
        map.insert("output".to_string(), Value::Array(output));
    }
}

fn response_items_match(left: &Value, right: &Value) -> bool {
    if left.get("type") != right.get("type") {
        return false;
    }

    if let (Some(left_id), Some(right_id)) = (
        left.get("id").and_then(Value::as_str),
        right.get("id").and_then(Value::as_str),
    ) {
        return left_id == right_id;
    }

    if let (Some(left_call_id), Some(right_call_id)) = (
        left.get("call_id").and_then(Value::as_str),
        right.get("call_id").and_then(Value::as_str),
    ) {
        return left_call_id == right_call_id;
    }

    left == right
}

fn response_item_should_be_preserved(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str) {
        Some("function_call")
        | Some("custom_tool_call")
        | Some("local_shell_call")
        | Some("tool_search_call") => true,
        _ => response_item_has_assistant_output_text(item),
    }
}

fn response_item_has_assistant_output_text(item: &Value) -> bool {
    item.get("role").and_then(Value::as_str) == Some("assistant")
        && item
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                parts.iter().any(|part| {
                    part.get("type").and_then(Value::as_str) == Some("output_text")
                        && part
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.trim().is_empty())
                })
            })
}

fn chatgpt_message_event_to_response_item(event: &Value) -> Option<Value> {
    if response_item_has_assistant_output_text(event) {
        return Some(event.clone());
    }

    if let Some(item) = event.get("item")
        && response_item_has_assistant_output_text(item)
    {
        return Some(item.clone());
    }

    let text = event
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| event.get("text").and_then(Value::as_str))
        .or_else(|| event.get("message").and_then(Value::as_str))?;
    if text.trim().is_empty() {
        return None;
    }
    Some(assistant_text_response_item(text))
}

fn assistant_text_response_item(text: &str) -> Value {
    json!({
        "id": format!("msg_{}", Uuid::new_v4()),
        "type": "message",
        "role": "assistant",
        "content": [{
            "type": "output_text",
            "text": text,
        }]
    })
}

fn parse_completion(raw: Value) -> Result<CodexCompletion> {
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("response missing id"))?
        .to_string();
    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let text = raw
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                let role = item.get("role").and_then(Value::as_str);
                if role != Some("assistant") {
                    return None;
                }
                item.get("content").and_then(Value::as_array).map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| {
                            let kind = part.get("type").and_then(Value::as_str);
                            if kind == Some("output_text") {
                                part.get("text").and_then(Value::as_str).map(|s| s.trim())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
            })
        })
        .filter(|s| !s.is_empty());

    let conversation_id = raw
        .get("conversation")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| {
            raw.get("conversation_id")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        });

    Ok(CodexCompletion {
        id,
        model,
        text,
        conversation_id,
        raw,
        // Filled in by `complete_with_input` from the upstream response headers
        // when they are still available; the body-parsing path leaves it None.
        rate_limits: None,
    })
}

/// Build the canonical (non-model-prefixed) `x-codex-*` header name for a given
/// window `kind` (`"primary"`/`"secondary"`) and `suffix`. An empty `kind`
/// yields the un-scoped `x-codex-<suffix>` form.
fn codex_rate_limit_header_name(kind: &str, suffix: &str) -> String {
    if kind.is_empty() {
        format!("x-codex-{suffix}")
    } else {
        format!("x-codex-{kind}-{suffix}")
    }
}

fn codex_header_str(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

/// Read a numeric `x-codex-*` header, tolerating a fractional value and
/// rounding to the nearest integer. OpenAI reports `used-percent` as a float
/// (e.g. `"37.4"`), so a strict integer parse would drop the value — and with
/// it the whole window — on the normal production path. Parsing as `f64` first
/// accepts both integer and fractional forms.
fn codex_header_rounded_i64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<i64> {
    codex_header_str(headers, name).and_then(|value| {
        value
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(|n| n.round() as i64)
    })
}

/// Parse a single rate-limit window (`primary` or `secondary`) from the
/// `x-codex-*` response headers. A window is only emitted when
/// `window-minutes > 0` AND `used-percent` parses (per the data contract).
/// `resetAt` uses `x-codex-<kind>-reset-at` when present, else
/// `now + x-codex-<kind>-reset-after-seconds`; it is omitted only when neither
/// header is available.
fn parse_codex_rate_limit_window(
    headers: &reqwest::header::HeaderMap,
    kind: &str,
    now: i64,
) -> Option<Value> {
    let window_minutes = codex_header_rounded_i64(
        headers,
        &codex_rate_limit_header_name(kind, "window-minutes"),
    )?;
    if window_minutes <= 0 {
        return None;
    }
    // Clamp to the 0–100 contract range so a stray upstream value can't render a
    // negative or overflowing "remaining" bar downstream.
    let used_percent =
        codex_header_rounded_i64(headers, &codex_rate_limit_header_name(kind, "used-percent"))?
            .clamp(0, 100);

    let reset_at =
        codex_header_rounded_i64(headers, &codex_rate_limit_header_name(kind, "reset-at")).or_else(
            || {
                codex_header_rounded_i64(
                    headers,
                    &codex_rate_limit_header_name(kind, "reset-after-seconds"),
                )
                .map(|seconds| now + seconds)
            },
        );

    let mut window = json!({
        "kind": kind,
        "usedPercent": used_percent,
        "windowMinutes": window_minutes,
    });
    if let Some(reset_at) = reset_at {
        window["resetAt"] = json!(reset_at);
    }
    Some(window)
}

/// Parse the `x-codex-*` rate-limit headers OpenAI returns on ChatGPT/Codex
/// responses into the `subscriptionUsage` contract JSON the frontend consumes:
///
/// ```json
/// {
///   "windows": [
///     { "kind": "primary"|"secondary", "usedPercent": <int>,
///       "windowMinutes": <int>, "resetAt": <unix_seconds_int> }
///   ],
///   "planName": <string|null>,
///   "capturedAt": <unix_seconds_int>
/// }
/// ```
///
/// Returns `None` when no usable window is present so callers can skip
/// reporting entirely. Never fails: malformed or absent headers are simply
/// dropped, keeping the user's response path unaffected.
fn parse_codex_rate_limit_headers(headers: &reqwest::header::HeaderMap) -> Option<Value> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);

    let mut windows = Vec::new();
    for kind in ["primary", "secondary"] {
        if let Some(window) = parse_codex_rate_limit_window(headers, kind, now) {
            windows.push(window);
        }
    }
    if windows.is_empty() {
        return None;
    }

    // The plan/limit name is provider-supplied. Prefer the primary window's
    // name, then secondary, then an un-scoped fallback.
    let plan_name = ["primary", "secondary", ""]
        .into_iter()
        .find_map(|kind| {
            codex_header_str(headers, &codex_rate_limit_header_name(kind, "limit-name"))
        })
        .map(Value::String)
        .unwrap_or(Value::Null);

    Some(json!({
        "windows": windows,
        "planName": plan_name,
        "capturedAt": now,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive_event(payload: &str) -> anyhow::Result<bool> {
        let mut completed = None;
        let mut incomplete = None;
        let mut items = Vec::new();
        let mut delta = String::new();
        process_chatgpt_stream_event(
            None,
            &[payload.to_string()],
            &mut completed,
            &mut incomplete,
            &mut items,
            &mut delta,
        )
    }

    #[test]
    fn codex_rate_limit_headers_parse_into_subscription_usage_contract() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-primary-used-percent",
            HeaderValue::from_static("42"),
        );
        headers.insert(
            "x-codex-primary-window-minutes",
            HeaderValue::from_static("300"),
        );
        headers.insert(
            "x-codex-primary-reset-at",
            HeaderValue::from_static("1893456000"),
        );
        headers.insert(
            "x-codex-secondary-used-percent",
            HeaderValue::from_static("10"),
        );
        headers.insert(
            "x-codex-secondary-window-minutes",
            HeaderValue::from_static("10080"),
        );
        headers.insert(
            "x-codex-secondary-reset-after-seconds",
            HeaderValue::from_static("3600"),
        );
        headers.insert(
            "x-codex-primary-limit-name",
            HeaderValue::from_static("GPT-5.3-Codex-Spark"),
        );

        let snapshot =
            parse_codex_rate_limit_headers(&headers).expect("usable windows should be present");
        assert_eq!(snapshot["planName"], json!("GPT-5.3-Codex-Spark"));

        let windows = snapshot["windows"].as_array().expect("windows array");
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["kind"], json!("primary"));
        assert_eq!(windows[0]["usedPercent"], json!(42));
        assert_eq!(windows[0]["windowMinutes"], json!(300));
        assert_eq!(windows[0]["resetAt"], json!(1893456000));
        assert_eq!(windows[1]["kind"], json!("secondary"));
        // The secondary window has no reset-at header, so resetAt is derived
        // from now + reset-after-seconds and must land in the future.
        assert!(windows[1]["resetAt"].as_i64().unwrap() >= 3600);
        assert!(snapshot["capturedAt"].as_i64().is_some());
    }

    #[test]
    fn codex_rate_limit_window_with_zero_minutes_is_omitted() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-primary-used-percent",
            HeaderValue::from_static("5"),
        );
        headers.insert(
            "x-codex-primary-window-minutes",
            HeaderValue::from_static("0"),
        );
        // window-minutes == 0 disqualifies the only window, so nothing is emitted.
        assert!(parse_codex_rate_limit_headers(&headers).is_none());
    }

    #[test]
    fn codex_rate_limit_used_percent_accepts_fractional_values() {
        // OpenAI reports used-percent as a float; a strict integer parse would
        // drop the whole window on the normal path. It must round instead.
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-primary-used-percent",
            HeaderValue::from_static("37.4"),
        );
        headers.insert(
            "x-codex-primary-window-minutes",
            HeaderValue::from_static("300"),
        );
        headers.insert(
            "x-codex-primary-reset-after-seconds",
            HeaderValue::from_static("1800"),
        );

        let snapshot = parse_codex_rate_limit_headers(&headers)
            .expect("a fractional percent must still yield a window");
        let windows = snapshot["windows"].as_array().expect("windows array");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["usedPercent"], json!(37)); // 37.4 rounds to 37
        assert_eq!(windows[0]["windowMinutes"], json!(300));
    }

    #[test]
    fn codex_rate_limit_window_without_reset_headers_still_emits() {
        // No reset-at and no reset-after-seconds: the window is still usable
        // (the frontend renders it without a reset label), so it must not be
        // dropped merely for lacking a reset time.
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-primary-used-percent",
            HeaderValue::from_static("42"),
        );
        headers.insert(
            "x-codex-primary-window-minutes",
            HeaderValue::from_static("300"),
        );

        let snapshot = parse_codex_rate_limit_headers(&headers)
            .expect("a window without a reset time is still usable");
        let windows = snapshot["windows"].as_array().expect("windows array");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["usedPercent"], json!(42));
        // resetAt is intentionally absent when neither reset header is present.
        assert!(windows[0].get("resetAt").is_none());
    }

    #[test]
    fn quota_exhaustion_names_its_cause() {
        // The backend answers HTTP 200 and reports quota exhaustion inside the
        // stream, so this frame is the only place the cause is stated.
        let err = drive_event(
            r#"{"type":"response.failed","response":{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}}"#,
        )
        .expect_err("a terminal failure frame must not be swallowed");
        let text = format!("{err}");
        assert!(text.contains("insufficient_quota"), "{text}");
        assert!(text.contains("You exceeded your current quota"), "{text}");
    }

    #[test]
    fn terminal_failure_reported_at_the_top_level_is_still_named() {
        let err = drive_event(
            r#"{"type":"response.failed","error":{"code":"rate_limit_exceeded","message":"slow down"}}"#,
        )
        .expect_err("a terminal failure frame must not be swallowed");
        let text = format!("{err}");
        assert!(text.contains("rate_limit_exceeded"), "{text}");
    }

    use serde_json::json;

    use super::{
        StreamedOutputItem, UpstreamWireApi, backfill_chatgpt_completed_output,
        build_chatgpt_payload, build_gemini_code_assist_payload, build_openai_payload,
        detect_upstream_wire_api, gemini_code_assist_request_url, gemini_code_assist_to_responses,
        parse_completion, read_chatgpt_stream_text,
    };

    #[test]
    fn chatgpt_payload_uses_requested_reasoning_effort_without_output_budget() {
        let payload = build_chatgpt_payload(
            "gpt-5.5",
            "You are Codex.",
            &[json!({
                "role": "user",
                "content": [{"type": "input_text", "text": "Review this diff."}]
            })],
            None,
            None,
            Some("low"),
            true,
            None,
            None,
            false,
            None,
            None,
        );

        assert_eq!(
            payload
                .pointer("/reasoning/effort")
                .and_then(|value| value.as_str()),
            Some("low")
        );
        assert!(payload.get("max_output_tokens").is_none());
    }

    #[test]
    fn chatgpt_payload_can_disable_tools_for_plain_text_completion() {
        let payload = build_chatgpt_payload(
            "gpt-5.5",
            "Return plain text.",
            &[json!({
                "role": "user",
                "content": [{"type": "input_text", "text": "Say ok."}]
            })],
            None,
            None,
            Some("low"),
            false,
            None,
            None,
            false,
            None,
            None,
        );

        assert!(payload.get("tools").is_none());
        assert!(payload.get("tool_choice").is_none());
        assert!(payload.get("parallel_tool_calls").is_none());
    }

    #[test]
    fn chatgpt_payload_preserves_requested_tools_and_tool_choice() {
        let tools = vec![json!({
            "type": "function",
            "name": "exec_command",
            "description": "Runs a command.",
            "parameters": {
                "type": "object",
                "properties": {
                    "cmd": { "type": "string" }
                },
                "required": ["cmd"],
                "additionalProperties": false
            },
            "strict": false
        })];
        let tool_choice = json!({
            "type": "function",
            "name": "exec_command"
        });
        let payload = build_chatgpt_payload(
            "gpt-5.5",
            "Use tools.",
            &[json!({
                "role": "user",
                "content": [{"type": "input_text", "text": "Inspect the repo."}]
            })],
            None,
            None,
            Some("high"),
            true,
            Some(&tools),
            Some(&tool_choice),
            false,
            Some(true),
            Some(&json!({"format": {"type": "text"}})),
        );

        assert_eq!(payload["tools"], json!(tools));
        assert_eq!(payload["tool_choice"], tool_choice);
        assert_eq!(payload["parallel_tool_calls"], json!(true));
        assert_eq!(payload["text"], json!({"format": {"type": "text"}}));
        assert!(payload.get("client_metadata").is_none());
    }

    #[test]
    fn openai_payload_preserves_requested_tools_and_tool_choice() {
        let tools = vec![json!({
            "type": "function",
            "name": "exec_command",
            "description": "Runs a command.",
            "parameters": {
                "type": "object",
                "properties": {
                    "cmd": { "type": "string" }
                },
                "required": ["cmd"],
                "additionalProperties": false
            },
            "strict": false
        })];
        let tool_choice = json!({
            "type": "function",
            "name": "exec_command"
        });
        let payload = build_openai_payload(
            "gpt-5.5",
            "Use tools.",
            &[json!({
                "role": "user",
                "content": [{"type": "input_text", "text": "Inspect the repo."}]
            })],
            None,
            None,
            Some("high"),
            true,
            Some(&tools),
            Some(&tool_choice),
            false,
            Some(false),
            Some(&json!({"format": {"type": "text"}})),
        );

        assert_eq!(payload["tools"], json!(tools));
        assert_eq!(payload["tool_choice"], tool_choice);
        assert_eq!(payload["parallel_tool_calls"], json!(false));
        assert_eq!(payload["text"], json!({"format": {"type": "text"}}));
        assert!(payload.get("client_metadata").is_none());
    }

    /// Codex's input for a Responses Lite model such as gpt-6-luna: the
    /// tools ride in an `additional_tools` item and the request has no
    /// `tools`.
    fn responses_lite_input() -> Vec<Value> {
        vec![
            json!({
                "type": "additional_tools",
                "role": "developer",
                "tools": [{ "type": "custom", "name": "exec" }]
            }),
            json!({
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Run the tests."}]
            }),
        ]
    }

    #[test]
    fn openai_payload_requires_a_tool_call_on_a_responses_lite_request() {
        let input = responses_lite_input();
        let auto = json!("auto");
        let build = |tools_enabled: bool, required_tool_call: bool| {
            build_openai_payload(
                "gpt-6-luna",
                "",
                &input,
                None,
                None,
                Some("medium"),
                tools_enabled,
                None,
                Some(&auto),
                required_tool_call,
                Some(false),
                None,
            )
        };

        // Without a required tool call, a Responses Lite request gets no
        // `tools` and no `tool_choice`: its own choice is not forwarded. Its
        // own `parallel_tool_calls` is.
        let unchanged = build(true, false);
        for key in ["tools", "tool_choice"] {
            assert!(unchanged.get(key).is_none(), "{key}: {unchanged}");
        }
        assert_eq!(unchanged["parallel_tool_calls"], json!(false));

        // With one it gets `tool_choice: "required"` and nothing else.
        let mut required = build(true, true);
        assert_eq!(required["tool_choice"], json!("required"));
        required
            .as_object_mut()
            .expect("payload object")
            .remove("tool_choice");
        assert_eq!(required, unchanged);

        // A plain text completion sends no tool control either way.
        let plain_text = build(false, true);
        for key in ["tools", "tool_choice", "parallel_tool_calls"] {
            assert!(plain_text.get(key).is_none(), "{key}: {plain_text}");
        }
    }

    #[test]
    fn openai_payload_forwards_parallel_tool_calls_only_for_a_responses_lite_request() {
        let lite = responses_lite_input();
        // A pinned lease that drops every tool in the item leaves it empty.
        let mut emptied = lite.clone();
        emptied[0]["tools"] = json!([]);
        let plain = &lite[1..];
        let own_tools = [json!({ "type": "function", "name": "exec_command", "parameters": {} })];
        let auto = json!("auto");
        let build = |input: &[Value],
                     tools_enabled: bool,
                     tools: Option<&[Value]>,
                     parallel_tool_calls: Option<bool>| {
            build_openai_payload(
                "gpt-6-luna",
                "",
                input,
                None,
                None,
                Some("medium"),
                tools_enabled,
                tools,
                Some(&auto),
                false,
                parallel_tool_calls,
                None,
            )
        };

        // A Responses Lite request sends the boolean it was given, and only
        // that: no `tools` and no `tool_choice`.
        for input in [&lite[..], &emptied[..]] {
            for parallel_tool_calls in [false, true] {
                let payload = build(input, true, None, Some(parallel_tool_calls));
                assert_eq!(
                    payload["parallel_tool_calls"],
                    json!(parallel_tool_calls),
                    "{payload}"
                );
                let mut without = payload.clone();
                without
                    .as_object_mut()
                    .expect("payload object")
                    .remove("parallel_tool_calls");
                assert_eq!(without, build(input, true, None, None), "{payload}");
            }
            let unsent = build(input, true, None, None);
            for key in ["tools", "tool_choice", "parallel_tool_calls"] {
                assert!(unsent.get(key).is_none(), "{key}: {unsent}");
            }
        }

        // Every other request is sent as before: no tool control without
        // tools or for a plain text completion, and its own tool controls,
        // `false` when absent, with tools of its own.
        for parallel_tool_calls in [None, Some(false), Some(true)] {
            let context = format!("parallel_tool_calls={parallel_tool_calls:?}");
            for payload in [
                build(plain, true, None, parallel_tool_calls),
                build(&lite, false, None, parallel_tool_calls),
                build(plain, false, None, parallel_tool_calls),
            ] {
                for key in ["tools", "tool_choice", "parallel_tool_calls"] {
                    assert!(payload.get(key).is_none(), "{context} {key}: {payload}");
                }
            }
            for input in [&lite[..], plain] {
                let payload = build(input, true, Some(&own_tools), parallel_tool_calls);
                assert_eq!(payload["tools"], json!(own_tools), "{context}");
                assert_eq!(payload["tool_choice"], json!("auto"), "{context}");
                assert_eq!(
                    payload["parallel_tool_calls"],
                    json!(parallel_tool_calls.unwrap_or(false)),
                    "{context}"
                );
            }
        }
    }

    #[test]
    fn chatgpt_payload_requires_a_tool_call_on_a_responses_lite_request() {
        let input = responses_lite_input();
        let auto = json!("auto");
        let build = |tools_enabled: bool, required_tool_call: bool| {
            build_chatgpt_payload(
                "gpt-6-luna",
                "",
                &input,
                None,
                None,
                Some("medium"),
                tools_enabled,
                None,
                Some(&auto),
                required_tool_call,
                Some(false),
                None,
            )
        };

        // Without a required tool call, a Responses Lite request gets `auto`
        // and none of the default tools, and its tools stay in the input.
        let unchanged = build(true, false);
        assert_eq!(unchanged["tool_choice"], json!("auto"));
        assert_eq!(unchanged["parallel_tool_calls"], json!(false));
        assert!(unchanged.get("tools").is_none(), "{unchanged}");
        assert_eq!(unchanged["input"], json!(input));

        // With one only the choice changes.
        let mut required = build(true, true);
        assert_eq!(required["tool_choice"], json!("required"));
        required["tool_choice"] = json!("auto");
        assert_eq!(required, unchanged);

        let plain_text = build(false, true);
        for key in ["tools", "tool_choice", "parallel_tool_calls"] {
            assert!(plain_text.get(key).is_none(), "{key}: {plain_text}");
        }
    }

    #[test]
    fn chatgpt_payload_adds_default_tools_only_without_an_additional_tools_item() {
        let lite = responses_lite_input();
        // A pinned lease that drops every tool in the item leaves it empty.
        let mut emptied = lite.clone();
        emptied[0]["tools"] = json!([]);
        let plain = &lite[1..];
        let own_tools = [json!({ "type": "function", "name": "exec_command", "parameters": {} })];
        let auto = json!("auto");
        let build = |input: &[Value], tools: Option<&[Value]>, required_tool_call: bool| {
            build_chatgpt_payload(
                "gpt-6-luna",
                "",
                input,
                None,
                None,
                Some("medium"),
                true,
                tools,
                Some(&auto),
                required_tool_call,
                Some(true),
                None,
            )
        };

        // A Responses Lite request, whether or not it requires a tool call
        // and even when the pin left its item empty, gets none of the default
        // tools. Its item and its tool controls stay as they were.
        for (name, input, required_tool_call, tool_choice) in [
            ("Lite", &lite[..], false, "auto"),
            ("Lite, required tool call", &lite[..], true, "required"),
            ("Lite, emptied item", &emptied[..], false, "auto"),
        ] {
            let payload = build(input, None, required_tool_call);
            assert!(payload.get("tools").is_none(), "{name}: {payload}");
            assert_eq!(payload["input"], json!(input), "{name}");
            assert_eq!(payload["tool_choice"], json!(tool_choice), "{name}");
            assert_eq!(payload["parallel_tool_calls"], json!(false), "{name}");
        }

        // A request without the item and without tools gets the default
        // tools with `auto`, as before.
        let defaults = resolve_chatgpt_tools("gpt-6-luna").tools;
        assert!(defaults.iter().any(|tool| tool["name"] == "shell"));
        let payload = build(plain, None, false);
        assert_eq!(payload["tools"], json!(defaults));
        assert_eq!(payload["tool_choice"], json!("auto"));
        assert_eq!(payload["parallel_tool_calls"], json!(false));
        assert_eq!(payload["input"], json!(plain));

        // A request with tools of its own sends them and its own controls,
        // with the item or without it.
        for input in [&lite[..], plain] {
            let payload = build(input, Some(&own_tools), false);
            assert_eq!(payload["tools"], json!(own_tools), "{input:?}");
            assert_eq!(payload["tool_choice"], json!("auto"), "{input:?}");
            assert_eq!(payload["parallel_tool_calls"], json!(true), "{input:?}");
            assert_eq!(payload["input"], json!(input), "{input:?}");
        }
    }

    #[test]
    fn payloads_with_tools_send_required_for_a_required_tool_call() {
        let tools = vec![json!({ "type": "function", "name": "exec_command", "parameters": {} })];
        let input = responses_lite_input();
        let auto = json!("auto");
        for chatgpt in [false, true] {
            for requested_choice in [None, Some(&auto)] {
                let build = |required_tool_call: bool| {
                    let build_payload = if chatgpt {
                        build_chatgpt_payload
                    } else {
                        build_openai_payload
                    };
                    build_payload(
                        "gpt-5.5",
                        "Use tools.",
                        &input[1..],
                        None,
                        None,
                        Some("medium"),
                        true,
                        Some(&tools),
                        requested_choice,
                        required_tool_call,
                        Some(true),
                        None,
                    )
                };
                let context = format!("chatgpt={chatgpt} tool_choice={requested_choice:?}");
                let unchanged = build(false);
                assert_eq!(unchanged["tool_choice"], json!("auto"), "{context}");

                let mut required = build(true);
                assert_eq!(required["tool_choice"], json!("required"), "{context}");
                assert_eq!(required["tools"], json!(tools), "{context}");
                assert_eq!(required["parallel_tool_calls"], json!(true), "{context}");
                required["tool_choice"] = json!("auto");
                assert_eq!(required, unchanged, "{context}");
            }
        }
    }

    #[test]
    fn tool_filter_runs_on_the_final_tools_and_clears_empty_tool_controls() {
        let without_web_search = |tools: &[Value]| {
            tools
                .iter()
                .filter(|tool| tool["type"] != "web_search")
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut payload = json!({
            "tools": [{ "type": "function", "name": "shell" }, { "type": "web_search" }],
            "tool_choice": "auto",
            "parallel_tool_calls": false,
        });
        filter_payload_tools(&mut payload, &without_web_search);
        assert_eq!(
            payload["tools"],
            json!([{ "type": "function", "name": "shell" }])
        );
        assert_eq!(payload["tool_choice"], json!("auto"));

        // A request left with no tools has the shape of one that sent none.
        let mut payload = json!({
            "tools": [{ "type": "web_search" }],
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "input": [],
        });
        filter_payload_tools(&mut payload, &without_web_search);
        assert_eq!(payload, json!({ "input": [] }));

        // Nothing to filter on a payload without tools.
        let mut payload = json!({ "messages": [] });
        filter_payload_tools(&mut payload, &without_web_search);
        assert_eq!(payload, json!({ "messages": [] }));
    }

    #[tokio::test]
    async fn client_falls_back_only_from_a_required_tool_choice_it_sent() {
        use axum::{Json, Router, extract::State, routing::post};
        use std::sync::{Arc, Mutex};

        // The model endpoint refuses every request as OpenAI might refuse
        // `required`, blaming `tool_choice`.
        type Bodies = Arc<Mutex<Vec<Value>>>;
        let bodies = Bodies::default();
        let app = Router::new()
            .route(
                "/v1/responses",
                post(
                    |State(bodies): State<Bodies>, Json(body): Json<Value>| async move {
                        bodies.lock().unwrap().push(body);
                        let refusal = json!({ "error": {
                            "message": "private-token",
                            "type": "invalid_request_error",
                            "param": "tool_choice",
                            "code": null
                        } });
                        (StatusCode::BAD_REQUEST, Json(refusal))
                    },
                ),
            )
            .with_state(bodies.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let tools = vec![json!({ "type": "function", "name": "exec_command", "parameters": {} })];
        let input = [json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": "Run the tests." }]
        })];
        let fallbacks = Arc::new(Mutex::new(Vec::new()));
        let client = |required_tool_call: bool, tool_choice: Option<Value>| {
            let fallbacks = fallbacks.clone();
            CodexClient::new(api_key_at(&endpoint))
                .unwrap()
                .with_response_controls(Some(tools.clone()), tool_choice, None, None)
                .with_required_tool_call(required_tool_call)
                .with_required_tool_call_fallback(Some(Box::new(
                    move |rejection: &ToolControlRejection| {
                        fallbacks.lock().unwrap().push(rejection.clone());
                    },
                )))
        };
        let sent_since = |from: usize| bodies.lock().unwrap()[from..].to_vec();

        // A `required` the client set goes once more without it, on the same
        // client, and the retry's failure is the one returned.
        let mut set_by_client = client(true, Some(json!("auto")));
        let error = set_by_client
            .complete_with_input(&input)
            .await
            .expect_err("refused twice");
        assert!(upstream_error::tool_control_rejection(&error).is_some());
        let attempts = sent_since(0);
        assert_eq!(attempts.len(), 2, "one retry");
        assert_eq!(attempts[0]["tool_choice"], json!("required"));
        assert_eq!(attempts[1]["tool_choice"], json!("auto"));
        assert!(set_by_client.required_tool_call_refused());
        assert_eq!(
            fallbacks.lock().unwrap().clone(),
            vec![ToolControlRejection {
                param: Some("tool_choice"),
                code: Some("invalid_request_error".to_string()),
            }]
        );

        // A request's own `required`, and a required tool call whose body a
        // tool filter left without tools, and so without `required`, are
        // sent once.
        let mut chosen_by_request = client(false, Some(json!("required")));
        let mut filtered = client(true, None).with_tool_filter(|_| Vec::new());
        for request in [&mut chosen_by_request, &mut filtered] {
            request
                .complete_with_input(&input)
                .await
                .expect_err("refused");
            assert!(!request.required_tool_call_refused());
        }
        let attempts = sent_since(2);
        assert_eq!(attempts.len(), 2, "no retry");
        assert_eq!(attempts[0]["tool_choice"], json!("required"));
        assert!(attempts[1].get("tool_choice").is_none(), "{}", attempts[1]);
        assert_eq!(fallbacks.lock().unwrap().len(), 1);
        server.abort();
    }

    /// An API key that sends to `endpoint`.
    fn api_key_at(endpoint: &str) -> Credentials {
        Credentials::ApiKey {
            key: "sk-test".to_string(),
            endpoint: Some(endpoint.to_string()),
            default_model: None,
        }
    }

    const EVERY_SERVICE_TIER_SETTING: [ServiceTierEndpoints; 3] = [
        ServiceTierEndpoints::OpenAi,
        ServiceTierEndpoints::All,
        ServiceTierEndpoints::Never,
    ];

    #[test]
    fn service_tier_goes_only_on_payloads_that_take_one() {
        use ServiceTierEndpoints::{All, Never, OpenAi};
        let tier = json!("default");
        let openai_api = api_key_at("https://api.openai.com/v1/responses");
        // An OpenAI-compatible provider, which may reject a tier.
        let compatible = api_key_at("https://api.groq.com/openai/v1/responses");
        for wire_api in [UpstreamWireApi::Responses, UpstreamWireApi::ChatCompletions] {
            for (credentials, endpoints, sent) in [
                (&openai_api, OpenAi, true),
                (&openai_api, All, true),
                (&openai_api, Never, false),
                (&compatible, OpenAi, false),
                (&compatible, All, true),
                (&compatible, Never, false),
            ] {
                let context = format!("{wire_api:?} {} {endpoints:?}", credentials.endpoint());
                let mut payload = json!({ "model": "gpt-6-luna" });
                set_payload_service_tier(
                    &mut payload,
                    credentials,
                    wire_api,
                    Some(&tier),
                    endpoints,
                );
                let expected = if sent {
                    json!({ "model": "gpt-6-luna", "service_tier": "default" })
                } else {
                    json!({ "model": "gpt-6-luna" })
                };
                assert_eq!(payload, expected, "{context}");

                // No tier sends none, rather than an explicit null.
                let mut payload = json!({ "model": "gpt-6-luna" });
                set_payload_service_tier(&mut payload, credentials, wire_api, None, endpoints);
                assert_eq!(payload, json!({ "model": "gpt-6-luna" }), "{context}");
            }
        }

        // A ChatGPT login goes to the Codex endpoint on the Responses wire
        // API, which is sent no tier, whatever the setting.
        let chatgpt = Credentials::ChatGpt {
            access_token: "chatgpt-test".to_string(),
            refresh_token: None,
            account_id: None,
            default_model: None,
            auth_path: None,
        };
        // Gemini Code Assist has no service tier.
        let gemini = Credentials::GeminiCodeAssist {
            access_token: "gemini-test".to_string(),
            project_id: "project-1".to_string(),
            endpoint: None,
            default_model: None,
        };
        for endpoints in EVERY_SERVICE_TIER_SETTING {
            let mut payload = json!({ "model": "gpt-6-luna" });
            set_payload_service_tier(
                &mut payload,
                &chatgpt,
                UpstreamWireApi::Responses,
                Some(&tier),
                endpoints,
            );
            assert_eq!(payload, json!({ "model": "gpt-6-luna" }), "{endpoints:?}");

            for credentials in [&openai_api, &gemini] {
                let mut payload = json!({ "model": "gemini-2.5-pro", "request": {} });
                set_payload_service_tier(
                    &mut payload,
                    credentials,
                    UpstreamWireApi::GeminiCodeAssist,
                    Some(&tier),
                    endpoints,
                );
                assert_eq!(
                    payload,
                    json!({ "model": "gemini-2.5-pro", "request": {} }),
                    "{endpoints:?}"
                );
            }
        }

        // The same rule, read from the credentials alone, which the proxy's
        // override log and health report use to say whether a tier goes
        // upstream.
        for endpoint in [
            "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/chat/completions",
        ] {
            let credentials = api_key_at(endpoint);
            assert!(sends_service_tier(&credentials, OpenAi), "{endpoint}");
            assert!(sends_service_tier(&credentials, All), "{endpoint}");
            assert!(!sends_service_tier(&credentials, Never), "{endpoint}");
        }
        for endpoint in [
            "https://api.groq.com/openai/v1/responses",
            "http://127.0.0.1:8080/v1/chat/completions",
        ] {
            let credentials = api_key_at(endpoint);
            assert!(!sends_service_tier(&credentials, OpenAi), "{endpoint}");
            assert!(sends_service_tier(&credentials, All), "{endpoint}");
            assert!(!sends_service_tier(&credentials, Never), "{endpoint}");
        }
        let gemini_endpoint =
            api_key_at("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
        for credentials in [&chatgpt, &gemini, &gemini_endpoint] {
            for endpoints in EVERY_SERVICE_TIER_SETTING {
                assert!(
                    !sends_service_tier(credentials, endpoints),
                    "{} {endpoints:?}",
                    credentials.endpoint()
                );
            }
        }
    }

    #[test]
    fn only_a_host_under_openai_com_is_the_openai_api() {
        for endpoint in [
            "https://api.openai.com/v1/responses",
            "https://API.OPENAI.COM/v1/responses",
            "https://Api.OpenAI.com/v1/chat/completions",
            "https://eu.api.openai.com/v1/responses",
            "https://api.openai.com./v1/responses",
            "https://api.openai.com:443/v1/responses",
            "http://api.openai.com/v1/responses",
            " https://api.openai.com/v1/responses ",
            // Userinfo is not the host: this request goes to OpenAI.
            "https://evil.example@api.openai.com/v1/responses",
        ] {
            assert!(is_openai_api_endpoint(endpoint), "{endpoint:?}");
        }
        for endpoint in [
            "https://openai.com.evil.example/v1/responses",
            "https://api.openai.com.evil.example/v1/responses",
            "https://api.openai.com%2eevil.example/v1/responses",
            // Userinfo that names the OpenAI host, with and without a
            // password, and a backslash that ends the host.
            "https://api.openai.com@evil.example/",
            "https://api.openai.com:443@evil.example/",
            "https://evil.example\\@api.openai.com/v1/responses",
            "https://evil.example/api.openai.com/v1/responses",
            "https://evil.example/v1/responses?host=api.openai.com",
            "https://evil.example/v1/responses#api.openai.com",
            "https://evilopenai.com/v1/responses",
            "https://api-openai.com/v1/responses",
            "https://api.openai.co/v1/responses",
            "http://localhost:8080/v1/responses",
            "http://api.openai.com.localhost:8080/v1/responses",
            "http://127.0.0.1:8080/api.openai.com/v1/responses",
            "http://10.0.0.1/v1/responses",
            "http://2130706433/v1/responses",
            "http://[::1]:8080/v1/responses",
            "api.openai.com/v1/responses",
            "",
        ] {
            assert!(!is_openai_api_endpoint(endpoint), "{endpoint:?}");
        }
    }

    #[test]
    fn service_tier_endpoints_setting_takes_three_values() {
        use ServiceTierEndpoints::{All, Never, OpenAi};
        for (raw, expected) in [
            (None, OpenAi),
            (Some(""), OpenAi),
            (Some("  "), OpenAi),
            (Some("openai"), OpenAi),
            (Some(" OpenAI "), OpenAi),
            (Some("all"), All),
            (Some("ALL"), All),
            (Some("none"), Never),
            (Some("None\n"), Never),
        ] {
            assert_eq!(
                ServiceTierEndpoints::parse(raw).expect("a known value"),
                expected,
                "{raw:?}"
            );
        }
        for raw in [
            "open-ai",
            "api.openai.com",
            "default",
            "true",
            "off",
            "openai,all",
        ] {
            let error = ServiceTierEndpoints::parse(Some(raw)).expect_err(raw);
            assert_eq!(
                error.to_string(),
                "PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS must be openai, all or none",
                "{raw:?}"
            );
        }
    }

    #[test]
    fn chatgpt_completed_output_backfills_from_text_delta() {
        let mut completed = json!({
            "id": "resp-empty",
            "model": "gpt-5.5",
            "status": "completed",
            "output": [],
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "total_tokens": 2
            }
        });

        backfill_chatgpt_completed_output(&mut completed, Vec::new(), "hello from delta");

        let completion = parse_completion(completed).expect("completion should parse");
        assert_eq!(completion.text.as_deref(), Some("hello from delta"));
    }

    #[test]
    fn chatgpt_completed_output_preserves_existing_output_text() {
        let mut completed = json!({
            "id": "resp-existing",
            "model": "gpt-5.5",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "existing"}]
            }]
        });

        backfill_chatgpt_completed_output(&mut completed, Vec::new(), "replacement");

        let completion = parse_completion(completed).expect("completion should parse");
        assert_eq!(completion.text.as_deref(), Some("existing"));
    }

    #[test]
    fn chatgpt_completed_output_backfills_from_done_item_before_delta() {
        let mut completed = json!({
            "id": "resp-empty",
            "model": "gpt-5.5",
            "status": "completed",
            "output": []
        });
        let done_item = json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "done item"}]
        });

        backfill_chatgpt_completed_output(
            &mut completed,
            vec![StreamedOutputItem {
                output_index: None,
                item: done_item,
                done: true,
            }],
            "delta fallback",
        );

        let completion = parse_completion(completed).expect("completion should parse");
        assert_eq!(completion.text.as_deref(), Some("done item"));
    }

    #[test]
    fn chatgpt_stream_reads_named_sse_events_without_json_type() {
        let stream = r#"event: response.output_text.delta
data: {"delta":"hello "}

event: response.output_text.delta
data: {"delta":"from named events"}

event: response.completed
data: {"response":{"id":"resp-named","model":"gpt-5.5","status":"completed","output":[]}}

data: [DONE]

"#;

        let raw = read_chatgpt_stream_text(stream).expect("stream should parse");
        let completion = parse_completion(raw).expect("completion should parse");

        assert_eq!(completion.text.as_deref(), Some("hello from named events"));
    }

    #[test]
    fn chatgpt_stream_surfaces_quota_exhaustion_from_response_failed() {
        // What OpenAI actually sends when the account is out of credit: HTTP 200,
        // then a terminal `response.failed` whose error sits under `response`.
        // Before this was handled the event fell through to the catch-all and the
        // stream ended with no assistant text, so a hard billing limit surfaced as
        // a generic failure with nothing to point at.
        let stream = r#"event: response.failed
data: {"type":"response.failed","response":{"id":"resp-quota","status":"failed","error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}}

data: [DONE]

"#;

        let error =
            read_chatgpt_stream_text(stream).expect_err("quota refusal must fail the stream");
        let rendered = format!("{error:#}");
        assert!(
            rendered.contains("insufficient_quota"),
            "the machine-readable code must survive: {rendered}"
        );
        assert!(
            rendered.contains("You exceeded your current quota"),
            "the operator-facing message must survive: {rendered}"
        );
    }

    #[test]
    fn chatgpt_stream_surfaces_top_level_response_error() {
        let stream = r#"event: response.error
data: {"type":"response.error","error":{"code":"rate_limit_exceeded","message":"Rate limit reached."}}

data: [DONE]

"#;

        let error =
            read_chatgpt_stream_text(stream).expect_err("an error event must fail the stream");
        let rendered = format!("{error:#}");
        assert!(rendered.contains("rate_limit_exceeded"), "{rendered}");
        assert!(rendered.contains("Rate limit reached."), "{rendered}");
    }

    #[test]
    fn chatgpt_stream_reads_named_output_text_done_event() {
        let stream = r#"event: response.output_text.done
data: {"text":"done text"}

event: response.completed
data: {"response":{"id":"resp-done","model":"gpt-5.5","status":"completed","output":[]}}

data: [DONE]

"#;

        let raw = read_chatgpt_stream_text(stream).expect("stream should parse");
        let completion = parse_completion(raw).expect("completion should parse");

        assert_eq!(completion.text.as_deref(), Some("done text"));
    }

    #[test]
    fn chatgpt_stream_preserves_function_call_output_item() {
        let stream = r#"event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","summary":[]},"output_index":0}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","summary":[]},"output_index":0}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_1","name":"exec_command"},"output_index":1}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","arguments":"{\"cmd\":\"pwd\"}","item_id":"fc_1","output_index":1}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\"cmd\":\"pwd\"}","call_id":"call_1","name":"exec_command"},"output_index":1}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp-tool","model":"gpt-5.5","status":"completed","output":[]}}

data: [DONE]

"#;

        let raw = read_chatgpt_stream_text(stream).expect("stream should parse");
        let output = raw["output"].as_array().expect("output should be present");

        assert_eq!(output.len(), 1);
        assert_eq!(output[0]["type"], json!("function_call"));
        assert_eq!(output[0]["name"], json!("exec_command"));
        assert_eq!(output[0]["arguments"], json!("{\"cmd\":\"pwd\"}"));
    }

    #[test]
    fn chatgpt_stream_merges_omitted_tool_search_call_with_completed_message() {
        let stream = r#"event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"tsc_1","type":"tool_search_call","call_id":"search-1","execution":"client","status":"completed","arguments":{"query":"Personal Browser snapshot","limit":5}},"output_index":0}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp-search","model":"gpt-5.5","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"I found the browser tool."}]}]}}

data: [DONE]

"#;

        let raw = read_chatgpt_stream_text(stream).expect("stream should parse");
        let output = raw["output"].as_array().expect("output should be present");

        assert_eq!(output.len(), 2);
        assert_eq!(output[0]["type"], json!("tool_search_call"));
        assert_eq!(output[0]["call_id"], json!("search-1"));
        assert_eq!(output[0]["execution"], json!("client"));
        assert_eq!(
            output[0]["arguments"]["query"],
            json!("Personal Browser snapshot")
        );
        assert_eq!(output[1]["id"], json!("msg_1"));
        let completion = parse_completion(raw).expect("completion should parse");
        assert_eq!(
            completion.text.as_deref(),
            Some("I found the browser tool.")
        );
    }

    #[test]
    fn chatgpt_stream_deduplicates_tool_search_call_in_completed_output() {
        let stream = r#"event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"tsc_1","type":"tool_search_call","call_id":"search-1","execution":"client","status":"completed","arguments":{"query":"Personal Browser snapshot","limit":5}},"output_index":0}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp-search","model":"gpt-5.5","status":"completed","output":[{"id":"tsc_1","type":"tool_search_call","call_id":"search-1","execution":"client","status":"completed","arguments":{"query":"Personal Browser snapshot","limit":5}},{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Already complete."}]}]}}

data: [DONE]

"#;

        let raw = read_chatgpt_stream_text(stream).expect("stream should parse");
        let output = raw["output"].as_array().expect("output should be present");

        assert_eq!(output.len(), 2);
        assert_eq!(
            output
                .iter()
                .filter(|item| item["type"] == json!("tool_search_call"))
                .count(),
            1
        );
        assert_eq!(output[0]["id"], json!("tsc_1"));
        assert_eq!(output[1]["id"], json!("msg_1"));
    }

    #[test]
    fn chatgpt_stream_returns_an_incomplete_response_with_only_its_finished_items() {
        // A finished call, a second call the stop cut off and the upstream finalized as
        // incomplete, then the start of an answer that never finished. The terminal event
        // carries no output, as the backend's `response.completed` often does not either.
        let stream = r#"event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\"cmd\":\"pwd\"}","call_id":"call_1","name":"exec_command"},"output_index":0}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"fc_2","type":"function_call","status":"in_progress","arguments":"","call_id":"call_2","name":"exec_command"},"output_index":1}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_2","type":"function_call","status":"incomplete","arguments":"{\"cmd\":\"rm","call_id":"call_2","name":"exec_command"},"output_index":1}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"A partial"}]},"output_index":2}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":" answer","output_index":2}

event: response.incomplete
data: {"type":"response.incomplete","response":{"id":"resp-cut","model":"gpt-6-luna","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":40,"output_tokens":128,"total_tokens":168}}}

data: [DONE]

"#;

        let raw = read_chatgpt_stream_text(stream).expect("an incomplete response is a response");
        assert_eq!(
            raw,
            json!({
                "id": "resp-cut", "model": "gpt-6-luna", "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "usage": {"input_tokens": 40, "output_tokens": 128, "total_tokens": 168},
                "output": [
                    {"id": "fc_1", "type": "function_call", "status": "completed",
                        "arguments": "{\"cmd\":\"pwd\"}", "call_id": "call_1",
                        "name": "exec_command"},
                    // Kept as the upstream finalized it; the proxy drops it before a client
                    // sees it.
                    {"id": "fc_2", "type": "function_call", "status": "incomplete",
                        "arguments": "{\"cmd\":\"rm", "call_id": "call_2",
                        "name": "exec_command"},
                ],
            })
        );
    }

    #[test]
    fn chatgpt_stream_incomplete_keeps_the_output_it_reports_and_reads_a_named_event() {
        let stream = r#"event: response.output_text.delta
data: {"delta":"never finished"}

event: response.incomplete
data: {"response":{"id":"resp-filtered","status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[{"id":"rs_1","type":"reasoning","summary":[]}]}}

"#;

        let raw = read_chatgpt_stream_text(stream).expect("an incomplete response is a response");
        assert_eq!(raw["status"], json!("incomplete"));
        assert_eq!(
            raw["output"],
            json!([{"id": "rs_1", "type": "reasoning", "summary": []}])
        );
        let completion = parse_completion(raw).expect("completion should parse");
        assert_eq!(
            completion.text, None,
            "deltas of a cut-off answer are dropped"
        );
    }

    #[test]
    fn chatgpt_stream_without_a_terminal_event_is_still_an_error() {
        let stream = r#"event: response.output_text.delta
data: {"delta":"truncated"}

"#;
        let error = read_chatgpt_stream_text(stream).expect_err("a truncated stream must fail");
        assert!(
            format!("{error:#}").contains("stream ended without a response.completed event"),
            "{error:#}"
        );
    }

    #[test]
    fn chatgpt_stream_incomplete_is_incomplete_whatever_status_its_response_reports() {
        // The event is what says the upstream stopped early. A response object without a status,
        // or one still reporting `in_progress`, must not let the call the stop truncated through.
        let finished_call = json!({"id": "fc_1", "type": "function_call", "status": "completed",
            "arguments": "{\"cmd\":\"pwd\"}", "call_id": "call_1", "name": "exec_command"});
        let cut_call = json!({"id": "fc_2", "type": "function_call", "status": "incomplete",
            "arguments": "{\"cmd\":\"rm", "call_id": "call_2", "name": "exec_command"});
        let usage = json!({"input_tokens": 40, "output_tokens": 128, "total_tokens": 168});
        for status in [None, Some("in_progress")] {
            let mut response = json!({"id": "resp-cut", "output": [], "usage": usage,
                "incomplete_details": {"reason": "max_output_tokens"}});
            if let Some(status) = status {
                response["status"] = json!(status);
            }
            let stream = format!(
                "event: response.output_item.done\ndata: {}\n\n\
                 event: response.output_item.done\ndata: {}\n\n\
                 event: response.incomplete\ndata: {}\n\n",
                json!({"type": "response.output_item.done", "output_index": 0,
                    "item": finished_call}),
                json!({"type": "response.output_item.done", "output_index": 1,
                    "item": cut_call}),
                json!({"type": "response.incomplete", "response": response}),
            );

            let raw = read_chatgpt_stream_text(&stream).expect("an incomplete response");
            assert_eq!(raw["status"], json!("incomplete"), "status {status:?}");
            assert_eq!(
                crate::incomplete_response::delivered_response(raw),
                json!({
                    "id": "resp-cut", "status": "completed", "usage": usage,
                    "output": [finished_call],
                }),
                "status {status:?}"
            );
        }
    }

    #[test]
    fn chatgpt_stream_reads_a_flat_incomplete_event() {
        // Like `response.completed`, the event may carry the response's fields itself instead
        // of a `response` object.
        let stream = r#"event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","role":"assistant","status":"incomplete","content":[{"type":"output_text","text":"A filtered"}]},"output_index":0}

data: {"type":"response.incomplete","id":"resp-flat","status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[],"usage":{"input_tokens":40,"output_tokens":12,"total_tokens":52}}

"#;

        let raw = read_chatgpt_stream_text(stream).expect("an incomplete response is a response");
        assert_eq!(raw["id"], json!("resp-flat"));
        assert_eq!(raw["status"], json!("incomplete"));
        // A filtered answer without a finished call completes with the text that arrived and the
        // proxy's notice after it, keeping the usage. The flat event's own fields stay, `type`
        // included.
        assert_eq!(
            crate::incomplete_response::delivered_response(raw),
            json!({
                "id": "resp-flat", "type": "response.incomplete", "status": "completed",
                "usage": {"input_tokens": 40, "output_tokens": 12, "total_tokens": 52},
                "output": [
                    {"id": "msg_1", "type": "message", "role": "assistant",
                        "status": "incomplete",
                        "content": [{"type": "output_text", "text": "A filtered"},
                            {"type": "output_text",
                                "text": "\n\nThe response was cut off before it finished (reason: content_filter).",
                                "annotations": []}]},
                ],
            })
        );
    }

    #[test]
    fn gemini_code_assist_request_url_appends_generate_content() {
        assert_eq!(
            gemini_code_assist_request_url("https://cloudcode-pa.googleapis.com"),
            "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
        );
        assert_eq!(
            gemini_code_assist_request_url(
                "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
            ),
            "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
        );
    }

    #[test]
    fn detect_upstream_wire_api_treats_cloudcode_as_gemini() {
        assert_eq!(
            detect_upstream_wire_api("https://cloudcode-pa.googleapis.com"),
            UpstreamWireApi::GeminiCodeAssist
        );
        assert_eq!(
            detect_upstream_wire_api("https://cloudcode-pa.googleapis.com/"),
            UpstreamWireApi::GeminiCodeAssist
        );
        assert_eq!(
            detect_upstream_wire_api(
                "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
            ),
            UpstreamWireApi::GeminiCodeAssist
        );
    }

    #[test]
    fn build_gemini_code_assist_payload_requires_project_id() {
        let input_items = vec![json!({
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        })];
        let result =
            build_gemini_code_assist_payload("gemini-2.5-pro", "system", &input_items, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn build_gemini_code_assist_payload_maps_input_and_project() {
        let input_items = vec![
            json!({
                "role": "user",
                "content": [{"type": "input_text", "text": "hello"}]
            }),
            json!({
                "role": "assistant",
                "content": [{"type": "output_text", "text": "world"}]
            }),
        ];
        let (payload, request_id) = build_gemini_code_assist_payload(
            "gemini-2.5-pro",
            "system instructions",
            &input_items,
            Some("proj-1"),
            Some("conv-1"),
        )
        .expect("payload should be constructed");

        assert!(!request_id.is_empty());
        assert_eq!(
            payload.get("project").and_then(|v| v.as_str()),
            Some("proj-1")
        );
        assert_eq!(
            payload
                .pointer("/request/session_id")
                .and_then(|v| v.as_str()),
            Some("conv-1")
        );
        assert_eq!(
            payload
                .pointer("/request/systemInstruction/parts/0/text")
                .and_then(|v| v.as_str()),
            Some("system instructions")
        );
        assert_eq!(
            payload
                .pointer("/request/contents/0/role")
                .and_then(|v| v.as_str()),
            Some("user")
        );
        assert_eq!(
            payload
                .pointer("/request/contents/1/role")
                .and_then(|v| v.as_str()),
            Some("model")
        );
    }

    #[test]
    fn gemini_code_assist_response_adapts_to_responses_shape() {
        let raw = json!({
            "traceId": "trace-123",
            "response": {
                "responseId": "resp-123",
                "modelVersion": "gemini-2.5-pro",
                "candidates": [{
                    "content": {
                        "parts": [
                            {"text": "Hello"},
                            {"text": "from Gemini"}
                        ]
                    }
                }],
                "usageMetadata": {
                    "promptTokenCount": 11,
                    "candidatesTokenCount": 7,
                    "totalTokenCount": 18
                }
            }
        });

        let adapted =
            gemini_code_assist_to_responses(raw, "fallback-model").expect("response should adapt");

        assert_eq!(adapted.get("id").and_then(|v| v.as_str()), Some("resp-123"));
        assert_eq!(
            adapted.get("model").and_then(|v| v.as_str()),
            Some("gemini-2.5-pro")
        );
        assert_eq!(
            adapted
                .pointer("/output/0/content/0/text")
                .and_then(|v| v.as_str()),
            Some("Hello\nfrom Gemini")
        );
        assert_eq!(
            adapted
                .pointer("/usage/input_tokens")
                .and_then(|v| v.as_u64()),
            Some(11)
        );
        assert_eq!(
            adapted
                .pointer("/usage/output_tokens")
                .and_then(|v| v.as_u64()),
            Some(7)
        );
        assert_eq!(
            adapted
                .pointer("/usage/total_tokens")
                .and_then(|v| v.as_u64()),
            Some(18)
        );
    }
}
