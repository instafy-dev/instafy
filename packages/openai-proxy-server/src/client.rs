use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use serde_json::{Map as JsonMap, Value, json};
use uuid::Uuid;

use crate::auth::{Credentials, response_indicates_chatgpt_token_expired};

const APPLY_PATCH_GRAMMAR: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../codex/codex-rs/core/src/tools/handlers/apply_patch.lark"
));

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
    requested_parallel_tool_calls: Option<bool>,
    requested_text_controls: Option<Value>,
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

fn global_reasoning_effort() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| match std::env::var("CODEX_REASONING_EFFORT") {
            Ok(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return None;
                }
                let lowered = trimmed.to_ascii_lowercase();
                match lowered.as_str() {
                    "minimal" | "low" | "medium" | "high" => Some(lowered),
                    _ => {
                        eprintln!(
                            "[proxy] Ignoring invalid CODEX_REASONING_EFFORT value `{}`; expected minimal|low|medium|high.",
                            trimmed
                        );
                        None
                    }
                }
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
            requested_parallel_tool_calls: None,
            requested_text_controls: None,
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
        let upstream_wire_api = if self.credentials.is_chatgpt() {
            UpstreamWireApi::Responses
        } else if self.credentials.gemini_code_assist_project_id().is_some() {
            UpstreamWireApi::GeminiCodeAssist
        } else {
            detect_upstream_wire_api(self.credentials.endpoint())
        };
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

        let previous_response_id = if allow_conversation {
            self.previous_response_id.as_deref()
        } else {
            None
        };

        let mut request_id_header: Option<String> = None;
        let payload = if self.credentials.is_chatgpt() {
            build_chatgpt_payload(
                &self.model,
                &self.instructions,
                input_items,
                conversation_id_for_request.as_deref(),
                previous_response_id,
                self.reasoning_effort.as_deref(),
                self.tools_enabled,
                self.requested_tools.as_deref(),
                self.requested_tool_choice.as_ref(),
                self.requested_parallel_tool_calls,
                self.requested_text_controls.as_ref(),
            )
        } else {
            match upstream_wire_api {
                UpstreamWireApi::Responses => build_openai_payload(
                    &self.model,
                    &self.instructions,
                    input_items,
                    conversation_id_for_request.as_deref(),
                    self.previous_response_id.as_deref(),
                    self.reasoning_effort.as_deref(),
                    self.tools_enabled,
                    self.requested_tools.as_deref(),
                    self.requested_tool_choice.as_ref(),
                    self.requested_parallel_tool_calls,
                    self.requested_text_controls.as_ref(),
                ),
                UpstreamWireApi::ChatCompletions => build_openai_chat_completions_payload(
                    &self.model,
                    &self.instructions,
                    input_items,
                )?,
                UpstreamWireApi::GeminiCodeAssist => {
                    let (payload, request_id) = build_gemini_code_assist_payload(
                        &self.model,
                        &self.instructions,
                        input_items,
                        self.credentials.gemini_code_assist_project_id(),
                        conversation_id_for_request.as_deref(),
                    )?;
                    request_id_header = Some(request_id);
                    payload
                }
            }
        };

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

        if std::env::var("CODEX_DEBUG_HTTP").as_deref() == Ok("1") {
            eprintln!(
                "--> POST {}\nHeaders: {:?}\nBody: {}",
                self.credentials.endpoint(),
                headers,
                serde_json::to_string_pretty(&payload).unwrap_or_default()
            );
        }

        let request_url = if upstream_wire_api == UpstreamWireApi::GeminiCodeAssist {
            gemini_code_assist_request_url(self.credentials.endpoint())
        } else {
            self.credentials.endpoint().to_string()
        };

        let response = self
            .send_upstream_request_with_retry(request_url.as_str(), &headers, &payload)
            .await?;

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
            let mut completion = parse_completion(body)?;
            completion.rate_limits = rate_limits;
            return Ok(completion);
        }

        let body: Value = response
            .json()
            .await
            .context("failed to decode JSON response")?;
        let mut completion = match upstream_wire_api {
            UpstreamWireApi::Responses => parse_completion(body)?,
            UpstreamWireApi::ChatCompletions => {
                let adapted = chat_completions_to_responses(body)?;
                parse_completion(adapted)?
            }
            UpstreamWireApi::GeminiCodeAssist => {
                let adapted = gemini_code_assist_to_responses(body, &self.model)?;
                parse_completion(adapted)?
            }
        };
        completion.rate_limits = rate_limits;
        Ok(completion)
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
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<empty>".to_string());
            if response_indicates_chatgpt_token_expired(StatusCode::UNAUTHORIZED, &body)
                && self
                    .credentials
                    .refresh_chatgpt_access_token(&self.http)
                    .await
                    .context("failed to refresh ChatGPT access token")?
            {
                response = self
                    .send_upstream_request(request_url, headers, payload)
                    .await?;
            } else {
                bail!(
                    "backend responded with {} for {}: {}",
                    StatusCode::UNAUTHORIZED,
                    request_url,
                    body
                );
            }
        }

        if !response.status().is_success() {
            let status = response.status();
            let text = response
                .text()
                .await
                .unwrap_or_else(|_| "<empty>".to_string());
            bail!(
                "backend responded with {} for {}: {}",
                status,
                request_url,
                text
            );
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
        payload["tool_choice"] = requested_tool_choice
            .cloned()
            .unwrap_or_else(|| json!("auto"));
        payload["parallel_tool_calls"] =
            Value::Bool(requested_parallel_tool_calls.unwrap_or(false));
    }

    if let Some(text_controls) = requested_text_controls
        && !text_controls.is_null()
    {
        payload["text"] = text_controls.clone();
    }

    payload
}

fn build_openai_chat_completions_payload(
    model: &str,
    instructions: &str,
    input_items: &[Value],
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

    Ok(json!({
        "model": model,
        "messages": messages,
        "stream": false,
        // Keep this high enough that providers with separate reasoning fields still return visible output.
        "max_tokens": 1024,
    }))
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
        payload["tool_choice"] = requested_tool_choice
            .cloned()
            .unwrap_or_else(|| json!("auto"));
        payload["parallel_tool_calls"] =
            Value::Bool(requested_parallel_tool_calls.unwrap_or(false));
    } else if tools_enabled {
        let tool_metadata = resolve_chatgpt_tools(model);
        payload["tools"] = Value::Array(tool_metadata.tools);
        payload["tool_choice"] = Value::String("auto".to_string());
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
            &mut completed_output_items,
            &mut assistant_text_delta,
        )?;
    }

    let mut completed =
        completed.ok_or_else(|| anyhow!("stream ended without a response.completed event"))?;
    backfill_chatgpt_completed_output(
        &mut completed,
        completed_output_items,
        assistant_text_delta.trim_end_matches('\n'),
    );
    Ok(completed)
}

#[derive(Debug)]
struct StreamedOutputItem {
    output_index: Option<usize>,
    item: Value,
}

impl StreamedOutputItem {
    fn from_event(event: &Value, item: Value) -> Self {
        Self {
            output_index: event
                .get("output_index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok()),
            item,
        }
    }
}

fn process_chatgpt_stream_event(
    event_kind: Option<&str>,
    data_lines: &[String],
    completed: &mut Option<Value>,
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
            match code {
                Some(code) => {
                    bail!("backend stream reported error: {} (code={})", message, code)
                }
                None => bail!("backend stream reported error: {}", message),
            }
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
                completed_output_items.push(StreamedOutputItem::from_event(&event, item.clone()));
            }
        }
        "response.output_item.done" => {
            if let Some(item) = event.get("item")
                && response_item_should_be_preserved(item)
            {
                completed_output_items.push(StreamedOutputItem::from_event(&event, item.clone()));
            }
        }
        "message" => {
            if let Some(item) = chatgpt_message_event_to_response_item(&event) {
                completed_output_items.push(StreamedOutputItem::from_event(&event, item));
            }
        }
        "response.completed" => {
            if let Some(response) = event.get("response") {
                *completed = Some(response.clone());
            } else if event.get("id").is_some() && event.get("status").is_some() {
                *completed = Some(event);
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
        value.parse::<f64>().ok().filter(|n| n.is_finite()).map(|n| n.round() as i64)
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
    let window_minutes =
        codex_header_rounded_i64(headers, &codex_rate_limit_header_name(kind, "window-minutes"))?;
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
        let mut items = Vec::new();
        let mut delta = String::new();
        process_chatgpt_stream_event(
            None,
            &[payload.to_string()],
            &mut completed,
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
        headers.insert("x-codex-primary-used-percent", HeaderValue::from_static("5"));
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
            Some(false),
            Some(&json!({"format": {"type": "text"}})),
        );

        assert_eq!(payload["tools"], json!(tools));
        assert_eq!(payload["tool_choice"], tool_choice);
        assert_eq!(payload["parallel_tool_calls"], json!(false));
        assert_eq!(payload["text"], json!({"format": {"type": "text"}}));
        assert!(payload.get("client_metadata").is_none());
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

        let error = read_chatgpt_stream_text(stream).expect_err("quota refusal must fail the stream");
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

        let error = read_chatgpt_stream_text(stream).expect_err("an error event must fail the stream");
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
