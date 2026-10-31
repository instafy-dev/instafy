use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use std::collections::HashMap;
use tracing::{info, warn};
use uuid::Uuid;

use origin_http_server::config::{
    CONTROLLER_TOKEN_REFRESH_TIMEOUT, ControllerTokenStore, SharedControllerToken,
};

use crate::agent_tokens::AgentTokenVerifier;
use crate::config::Config;
use crate::jobs::user_input_request::WorkerInputRequest;
use crate::resources::ResourceSampler;
use runtime_contracts::ProxyEnvelopePayload;
use runtime_contracts::multi_agent::AgentRuntimeSettings;

const REQUIRED_AGENT_SCOPES: &[&str] = &[
    "agent.lease",
    "agent.heartbeat",
    "agent.message",
    "agent.complete",
    "agent.secrets",
    "agent.stop",
];
const MAX_AGENT_MESSAGE_CONTENT_CHARS: usize = 32_000;
const MAX_AGENT_SUMMARY_CHARS: usize = 32_000;
const MAX_AGENT_METADATA_STRING_CHARS: usize = 8_000;
/// Every list in a payload sent to the controller keeps at most this many
/// entries, its first ones. A run log keeps its end within it (see
/// `jobs::CODEX_RUN_LOG_TAIL_EVENTS`), since its last event carries the turn's usage.
pub(crate) const MAX_AGENT_METADATA_ARRAY_ITEMS: usize = 80;
const MAX_AGENT_METADATA_DEPTH: usize = 8;

pub struct ControllerClient {
    http: reqwest::Client,
    base_url: Url,
    // Shared with the origin server's presence loop (#144): registration
    // renewals write here and every reader sees the freshest token.
    runtime_access_token: SharedControllerToken,
    // Freshest controller-minted agent JWT; per-job tasks clone Registration
    // at spawn, so requests resolve their bearer from here first (#144).
    current_agent_token: Mutex<Option<String>>,
    poll_interval: Duration,
    lease_wait: Duration,
    lease_max_jobs: u32,
    lease_seconds: u32,
    #[allow(dead_code)]
    heartbeat_seconds: u32,
    agent_tokens: AgentTokenVerifier,
    resources: Mutex<ResourceSampler>,
    // One profile baseline/writer survives registration and token renewals.
    pub(crate) browser_profile_session:
        tokio::sync::Mutex<crate::browser_profile::BrowserProfileSession>,
}

/// A version belongs to these exact bytes, not merely to a GET request. Version
/// zero represents the controller's empty store; positive versions require a
/// successful restore before the runtime may upload changes.
pub struct BrowserProfileSnapshot {
    pub version: i64,
    pub archive: Option<Vec<u8>>,
}

/// Why a versioned profile upload did not land, by what it means for the
/// stored copy. `Conflict` (409): another writer's version is stored.
/// `Rejected` (400, 401, 403, 404, 413 or 428): the controller refused the
/// request, so nothing was written. `Uncertain`: a network error, timeout,
/// other status or unexpected acknowledgement; the write may have committed.
#[derive(Debug)]
pub enum UploadFailure {
    Conflict,
    Rejected(StatusCode),
    Uncertain(anyhow::Error),
}

impl UploadFailure {
    fn from_status(status: StatusCode) -> Self {
        match status {
            StatusCode::CONFLICT => Self::Conflict,
            StatusCode::BAD_REQUEST
            | StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::NOT_FOUND
            | StatusCode::PAYLOAD_TOO_LARGE
            | StatusCode::PRECONDITION_REQUIRED => Self::Rejected(status),
            _ => Self::Uncertain(anyhow!("browser profile upload failed: status={status}")),
        }
    }

    pub fn into_error(self) -> anyhow::Error {
        match self {
            Self::Conflict => anyhow!(
                "browser profile upload failed: status={}",
                StatusCode::CONFLICT
            ),
            Self::Rejected(status) => anyhow!("browser profile upload failed: status={status}"),
            Self::Uncertain(error) => error,
        }
    }
}

#[derive(Deserialize)]
struct BrowserProfileManifest {
    scope: String,
    version: i64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Registration {
    pub runtime_id: Uuid,
    pub agent_token: String,
    pub runtime_token: Option<String>,
    pub lease_url: Url,
    pub heartbeat_url: Url,
    pub stop_url: Option<Url>,
    pub lease_id: Option<Uuid>,
    pub proxy: Option<ProxyEnvelopePayload>,
    pub lease_scope: Option<String>,
    pub tenant_projects: Vec<Uuid>,
    pub workspace_manifest: Option<JsonValue>,
    pub parent_lease_id: Option<Uuid>,
    pub agent_token_scopes: Vec<String>,
    pub agent_token_issued_at: Option<String>,
    pub agent_token_expires_at: Option<String>,
    pub agent_token_ttl: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisteredWorkerInputRequest {
    pub request_id: Uuid,
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct RuntimeRegisterResponse {
    #[serde(rename = "runtime_id")]
    runtime_id: Uuid,
    #[serde(rename = "agent_token")]
    agent_token: String,
    #[serde(rename = "lease_url")]
    lease_url: String,
    #[serde(rename = "heartbeat_url")]
    heartbeat_url: String,
    #[serde(rename = "stop_url")]
    stop_url: Option<String>,
    #[serde(rename = "leaseId")]
    lease_id: Option<Uuid>,
    proxy: Option<ProxyEnvelopePayload>,
    #[serde(rename = "agent_token_scopes")]
    agent_token_scopes: Option<Vec<String>>,
    #[serde(rename = "agent_token_issued_at")]
    agent_token_issued_at: Option<String>,
    #[serde(rename = "agent_token_expires_at")]
    agent_token_expires_at: Option<String>,
    #[serde(rename = "agent_token_ttl")]
    agent_token_ttl: Option<i64>,
    #[serde(rename = "runtime_token")]
    runtime_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LeaseJob {
    pub id: Uuid,
    pub intent: Option<String>,
    #[serde(rename = "project_id")]
    pub project_id: Option<Uuid>,
    #[serde(rename = "run_id")]
    pub run_id: Option<Uuid>,
    #[serde(rename = "conversation_id")]
    pub conversation_id: Option<Uuid>,
    #[serde(rename = "session_id")]
    pub session_id: Option<Uuid>,
    #[serde(default, rename = "credential_id")]
    pub credential_id: Option<Uuid>,
    #[serde(default)]
    pub payload: JsonValue,
    #[serde(default)]
    pub proxy: Option<ProxyEnvelopePayload>,
    #[serde(default, rename = "controller_token")]
    pub controller_token: Option<String>,
    #[serde(default, rename = "controller_token_scopes")]
    pub controller_token_scopes: Option<Vec<String>>,
    #[serde(default, rename = "controller_token_expires_at")]
    pub controller_token_expires_at: Option<String>,
    #[serde(default, rename = "workspace_token")]
    pub workspace_token: Option<String>,
    #[serde(default, rename = "workspace_token_scopes")]
    pub workspace_token_scopes: Option<Vec<String>>,
    #[serde(default, rename = "workspace_token_expires_at")]
    pub workspace_token_expires_at: Option<String>,
    /// How many times the controller has leased this job, this lease
    /// included.
    #[serde(default, rename = "lease_attempts")]
    pub lease_attempts: i32,
    /// The device grants the job holds; empty for every other job. Such a job runs only as a
    /// granted turn (`provider_mcp`), and once: the controller leases it once, so what it did
    /// must not happen again.
    #[serde(default)]
    pub grants: Vec<LeasedGrant>,
    /// The token the granted turn's broker alone makes its device calls with.
    #[serde(default)]
    pub grant_token: Option<GrantToken>,
}

impl LeaseJob {
    /// An earlier lease of this job ended without a result: a stop (or a
    /// lease that expired) requeued it mid-turn, and this lease resumes it.
    pub fn resumes_an_interrupted_attempt(&self) -> bool {
        self.lease_attempts > 1
    }
}

/// A device grant a leased job holds (the controller's `device_grants.rs`): the tools its person
/// granted, as the device published them in MCP `tools/list` shape. One the turn may no longer
/// use comes with only why.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeasedGrant {
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default)]
    pub tools: Vec<JsonValue>,
    /// Why, in words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

/// A granted job's broker-only token, which `Debug` never prints.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct GrantToken(pub String);

impl std::fmt::Debug for GrantToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
}

#[derive(Debug, Deserialize)]
struct LeaseResponse {
    jobs: Vec<LeaseJob>,
    #[serde(default)]
    waited: bool,
}

/// One lease poll's answer.
#[derive(Debug)]
pub struct LeasedJobs {
    pub jobs: Vec<LeaseJob>,
    /// The controller held the poll open waiting for work. Controllers that
    /// predate waiting answer at once and never set it.
    pub waited: bool,
}

/// A leased job carries tokens and signed attachment URLs, so no part of a
/// successful lease's body goes into an error or a log. serde's own message
/// can quote the value it rejected, so only its category and position are kept.
fn parse_lease_response(text: &str) -> Result<LeasedJobs, LeaseError> {
    serde_json::from_str::<LeaseResponse>(text)
        .map(|parsed| LeasedJobs {
            jobs: parsed.jobs,
            waited: parsed.waited,
        })
        .map_err(|error| {
            LeaseError::Other(anyhow!(
                "failed to parse lease response ({} bytes): {:?} error at line {} column {}",
                text.len(),
                error.classify(),
                error.line(),
                error.column()
            ))
        })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentJobInput {
    pub command_id: Uuid,
    pub job_id: Uuid,
    pub run_id: Option<Uuid>,
    pub message_id: Option<Uuid>,
    pub sequence: i64,
    pub target_turn_id: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
struct AgentJobInputPollResponse {
    commands: Vec<AgentJobInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentJobInputPollRequest<'a> {
    active_turn_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentJobInputAckRequest<'a> {
    outcome: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_turn_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSecretInventoryItemResponse {
    name: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct AgentSecretsResponse {
    env: Option<JsonValue>,
    inventory: Option<Vec<AgentSecretInventoryItemResponse>>,
    #[serde(default, rename = "runtimeSettings")]
    runtime_settings: AgentRuntimeSettings,
    #[serde(default, rename = "researchBudgetToken")]
    research_budget_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentSecretInventoryItem {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JobSecrets {
    pub env: HashMap<String, String>,
    pub inventory: Vec<AgentSecretInventoryItem>,
    /// Missing/malformed legacy inventory cannot establish setting provenance.
    pub inventory_complete: bool,
    /// Controller-owned policy, separate from granted project secrets.
    pub runtime_settings: AgentRuntimeSettings,
    pub research_budget: crate::research_budget::ResearchBudgetAccess,
}

/// The code the controller's refusals carry once the runtime's space was
/// deleted.
const SPACE_DELETED_CODE: &str = "space_deleted";

/// The controller refused the runtime because its space was deleted. Nothing
/// brings a deleted space back, so the agent stops instead of retrying.
#[derive(Debug, thiserror::Error)]
#[error("the controller refused the runtime: its space was deleted")]
pub struct SpaceDeleted;

#[derive(Deserialize)]
struct RefusalCode {
    code: Option<String>,
}

/// Whether `status` and `body` are the controller's `410 Gone` for a deleted
/// space. A `409` with the same code refuses one job's call: the job ends, and
/// the registration or lease poll that follows is what ends the agent.
fn is_space_deleted_refusal(status: StatusCode, body: &str) -> bool {
    status == StatusCode::GONE
        && serde_json::from_str::<RefusalCode>(body)
            .ok()
            .and_then(|refusal| refusal.code)
            .is_some_and(|code| code == SPACE_DELETED_CODE)
}

#[derive(Debug)]
pub enum LeaseError {
    Unauthorized,
    SpaceDeleted,
    Other(anyhow::Error),
}

impl From<anyhow::Error> for LeaseError {
    fn from(error: anyhow::Error) -> Self {
        Self::Other(error)
    }
}

impl ControllerClient {
    pub fn new(config: &Config) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .context("failed to construct reqwest client")?;

        Ok(Self {
            http,
            base_url: config.controller_base_url.clone(),
            runtime_access_token: std::sync::Arc::new(ControllerTokenStore::new(
                config.runtime_access_token.clone(),
            )),
            current_agent_token: Mutex::new(None),
            poll_interval: config.poll_interval,
            lease_wait: config.lease_wait,
            lease_max_jobs: config.lease_max_jobs,
            lease_seconds: config.lease_seconds,
            heartbeat_seconds: config.heartbeat_seconds,
            agent_tokens: AgentTokenVerifier::new(config.controller_jwks_url.clone()),
            resources: Mutex::new(ResourceSampler::new(config.workspace_root.clone())),
            browser_profile_session: tokio::sync::Mutex::new(Default::default()),
        })
    }

    async fn send_register_request(
        &self,
        url: &Url,
        request_body: &JsonValue,
        token: Option<&str>,
    ) -> Result<(StatusCode, String)> {
        let mut request = self
            .http
            .post(url.clone())
            .header("content-type", "application/json")
            .json(request_body);

        if let Some(value) = token {
            request = request.bearer_auth(value);
        }

        let response = request.send().await.context("agent login request failed")?;
        let status = response.status();
        let text = response.text().await.context("register runtime body")?;
        Ok((status, text))
    }

    fn read_runtime_access_token(&self) -> Option<String> {
        self.runtime_access_token.current()
    }

    fn store_runtime_access_token(&self, token: String) {
        self.runtime_access_token.store(token);
    }

    /// Live handle to the runtime token for the origin server's presence
    /// loop; registration renewals keep it fresh (#144).
    pub fn runtime_token_handle(&self) -> SharedControllerToken {
        self.runtime_access_token.clone()
    }

    /// Resolves once a re-registration has published fresh credentials, or the
    /// wait times out. Callers use it to recover from a single 401 without
    /// growing their own renewal logic: registration mints the runtime token
    /// and the agent token together, so one bump covers both.
    ///
    /// Returns false when no renewal landed — the caller must surface the
    /// original failure instead of retrying, so a genuinely dead credential
    /// cannot turn into a retry loop.
    async fn refresh_credentials_once(&self) -> bool {
        self.runtime_access_token
            .refresh_once(CONTROLLER_TOKEN_REFRESH_TIMEOUT)
            .await
    }

    /// The freshest agent token when a renewal has landed, else the
    /// spawn-time one captured in the registration snapshot.
    fn bearer_for_agent(&self, registration: &Registration) -> String {
        self.current_agent_token
            .lock()
            .clone()
            .unwrap_or_else(|| registration.agent_token.clone())
    }

    pub async fn register_runtime(&self, config: &Config) -> Result<Registration> {
        let (path, request_body) = if let Some(lease_id) = config.runtime_lease_id {
            let mut payload = serde_json::Map::new();
            payload.insert(
                "project_id".to_string(),
                JsonValue::String(config.project_id.to_string()),
            );
            payload.insert(
                "type".to_string(),
                JsonValue::String(config.provider.clone()),
            );
            payload.insert(
                "idle_ttl_seconds".to_string(),
                JsonValue::from(config.lease_seconds),
            );
            payload.insert(
                "version".to_string(),
                JsonValue::String(config.runtime_version.clone()),
            );
            payload.insert("capabilities".to_string(), config.capabilities.clone());
            payload.insert("metadata".to_string(), config.metadata.clone());
            payload.insert(
                "lease_id".to_string(),
                JsonValue::String(lease_id.to_string()),
            );
            if let Some(name) = config.display_name.as_ref() {
                payload.insert("display_name".to_string(), JsonValue::String(name.clone()));
            }
            if let Some(runtime_id) = config.runtime_id {
                payload.insert(
                    "runtime_id".to_string(),
                    JsonValue::String(runtime_id.to_string()),
                );
            }
            if let Some(scope) = config.lease_scope.as_ref() {
                payload.insert("lease_scope".to_string(), JsonValue::String(scope.clone()));
            }
            if let Some(manifest) = config.workspace_manifest.as_ref() {
                payload.insert("workspace_manifest".to_string(), manifest.clone());
            }
            ("/runtime/register", JsonValue::Object(payload))
        } else {
            let mut request_body = json!({
                "projectId": config.project_id,
                "provider": config.provider.clone(),
                "idleTtlSeconds": config.lease_seconds,
                "version": config.runtime_version.clone(),
                "capabilities": config.capabilities.clone(),
                "metadata": config.metadata.clone(),
            });

            if let Some(name) = config.display_name.as_ref() {
                if let Some(map) = request_body.as_object_mut() {
                    map.insert("displayName".to_string(), JsonValue::String(name.clone()));
                }
            }

            ("/runtime/register", request_body)
        };

        let url = self.base_url.join(path)?;
        let mut token_candidates: Vec<Option<String>> = vec![self.read_runtime_access_token()];
        if let Ok(value) = std::env::var("SUPABASE_SERVICE_ROLE_KEY") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                token_candidates.push(Some(trimmed.to_string()));
            }
        }
        if let Ok(value) = std::env::var("CONTROLLER_INTERNAL_TOKEN") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                token_candidates.push(Some(trimmed.to_string()));
            }
        }
        token_candidates.retain(|entry| entry.as_ref().map(|v| !v.is_empty()).unwrap_or(false));

        let mut parsed: Option<RuntimeRegisterResponse> = None;
        let mut last_error: Option<(StatusCode, String)> = None;

        for (index, token) in token_candidates.iter().enumerate() {
            let (status, text) = self
                .send_register_request(&url, &request_body, token.as_deref())
                .await?;
            if status.is_success() {
                parsed = Some(
                    serde_json::from_str(&text)
                        .with_context(|| format!("failed to parse register response: {}", text))?,
                );
                break;
            }
            if is_space_deleted_refusal(status, &text) {
                return Err(SpaceDeleted.into());
            }

            last_error = Some((status, text.clone()));
            if !matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                return Err(anyhow::anyhow!(
                    "runtime register failed: status={} body={}",
                    status,
                    text
                ));
            }
            if index + 1 < token_candidates.len() {
                warn!(
                    %status,
                    "runtime register unauthorized; retrying with fallback token"
                );
            }
        }

        // Self-heal a stale spawn-time token: another local process may have
        // refreshed and rotated the shared CLI session while this agent kept
        // presenting the token it was launched with. Re-read the persisted
        // session and retry once with its access token; if that token is also
        // rejected (or the file is absent), fall through to the existing
        // retry behavior.
        if parsed.is_none()
            && matches!(
                last_error.as_ref().map(|(status, _)| *status),
                Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
            )
        {
            if let Some(config_path) = crate::cli_session::config_path() {
                let reloaded_token = crate::cli_session::access_token_if_untried(
                    crate::cli_session::read_access_token(&config_path),
                    token_candidates.iter().filter_map(|token| token.as_deref()),
                );
                if let Some(reloaded_token) = reloaded_token {
                    warn!(
                        config_path = %config_path.display(),
                        "runtime register unauthorized; recovering with the access token re-read from the persisted CLI session"
                    );
                    let (status, text) = self
                        .send_register_request(&url, &request_body, Some(&reloaded_token))
                        .await?;
                    if status.is_success() {
                        // Later registrations (proactive renewal, tunnel
                        // refresh) must present the recovered token instead of
                        // the stale spawn-time one. A renewed runtime_token in
                        // the response still overrides this below.
                        self.store_runtime_access_token(reloaded_token);
                        parsed = Some(serde_json::from_str(&text).with_context(|| {
                            format!("failed to parse register response: {}", text)
                        })?);
                    } else if is_space_deleted_refusal(status, &text) {
                        return Err(SpaceDeleted.into());
                    } else {
                        warn!(
                            %status,
                            "re-read CLI session token was also rejected; keeping existing register retry behavior"
                        );
                        last_error = Some((status, text));
                    }
                }
            }
        }

        let parsed = parsed.ok_or_else(|| {
            let (status, body) = last_error.unwrap_or((
                StatusCode::INTERNAL_SERVER_ERROR,
                "missing runtime register response".to_string(),
            ));
            anyhow::anyhow!("runtime register failed: status={} body={}", status, body)
        })?;

        let claims = self
            .agent_tokens
            .verify(
                &parsed.agent_token,
                &config.project_id,
                Some(&parsed.runtime_id),
                REQUIRED_AGENT_SCOPES,
            )
            .await
            .context("failed to verify agent token")?;

        let lease_url = self.absolute_url(&parsed.lease_url)?;
        let heartbeat_url = self.absolute_url(&parsed.heartbeat_url)?;
        let stop_url = parsed
            .stop_url
            .as_deref()
            .map(|value| self.absolute_url(value))
            .transpose()?;

        info!(
            runtime_id = %parsed.runtime_id,
            lease_url = lease_url.as_str(),
            heartbeat_url = heartbeat_url.as_str(),
            lease_id = parsed.lease_id.as_ref().map(Uuid::to_string),
            agent_token_expires_at = claims.exp,
            "registered runtime"
        );

        let agent_token_scopes = parsed
            .agent_token_scopes
            .clone()
            .unwrap_or_else(|| claims.scopes.clone());
        // Proactive registration renewal is scheduled from this expiry. Fall
        // back to the verified JWT `exp` claim so a controller that omits the
        // informational field still gets renewed before the token lapses.
        let agent_token_expires_at = parsed.agent_token_expires_at.clone().or_else(|| {
            DateTime::<Utc>::from_timestamp(claims.exp, 0).map(|expires_at| expires_at.to_rfc3339())
        });

        // Per-job tasks clone `Registration` at spawn and would otherwise
        // present the register-time agent token forever; requests resolve
        // their bearer through `bearer_for_agent` so renewals land (#144).
        // Published before the runtime token so a consumer woken by the
        // generation bump below already sees both fresh credentials.
        *self.current_agent_token.lock() = Some(parsed.agent_token.clone());

        match parsed
            .runtime_token
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            Some(renewed_runtime_token) => {
                self.store_runtime_access_token(renewed_runtime_token.to_string())
            }
            // No new runtime token this round, but a renewal did complete.
            // Waiters are blocked on "a refresh happened", so releasing them
            // here is what keeps a rejected consumer from waiting out its
            // whole timeout for a value that is never going to change.
            None => self.runtime_access_token.note_refreshed(),
        }

        Ok(Registration {
            runtime_id: parsed.runtime_id,
            agent_token: parsed.agent_token,
            runtime_token: parsed.runtime_token,
            lease_url,
            heartbeat_url,
            stop_url,
            lease_id: parsed.lease_id,
            proxy: parsed.proxy,
            lease_scope: config.lease_scope.clone(),
            tenant_projects: config.tenant_projects.clone(),
            workspace_manifest: config.workspace_manifest.clone(),
            parent_lease_id: config.parent_lease_id,
            agent_token_scopes,
            agent_token_issued_at: parsed.agent_token_issued_at,
            agent_token_expires_at,
            agent_token_ttl: parsed.agent_token_ttl,
        })
    }

    pub async fn lease_once(&self, reg: &Registration) -> Result<LeasedJobs, LeaseError> {
        let request = self
            .http
            .post(reg.lease_url.clone())
            .header("content-type", "application/json")
            .bearer_auth(self.bearer_for_agent(reg));

        let resources = self.resources.lock().sample();
        let mut payload = json!({
            "runtime_id": reg.runtime_id,
            "max": self.lease_max_jobs,
            "lease_seconds": self.lease_seconds,
            "resources": resources,
            "supports_workspace_token": true,
        });
        if !self.lease_wait.is_zero() {
            payload["wait_ms"] = json!(self.lease_wait.as_millis() as u64);
            // A held poll re-checks at least this often, as this runtime polled.
            payload["poll_interval_ms"] = json!(self.poll_interval.as_millis() as u64);
        }

        // A controller may hold the poll for up to `lease_wait`; the usual
        // request budget starts after that.
        let response = request
            .timeout(self.lease_wait + Duration::from_secs(20))
            .json(&payload)
            .send()
            .await
            .map_err(|error| LeaseError::Other(anyhow!("lease request failed: {error}")))?;

        let status = response.status();
        let text = response.text().await.map_err(|error| {
            LeaseError::Other(anyhow!("lease response body read failed: {error}"))
        })?;

        if status == StatusCode::UNAUTHORIZED {
            return Err(LeaseError::Unauthorized);
        }
        if is_space_deleted_refusal(status, &text) {
            return Err(LeaseError::SpaceDeleted);
        }

        if !status.is_success() {
            return Err(LeaseError::Other(anyhow!(
                "lease request failed: status={} body={}",
                status,
                text
            )));
        }

        parse_lease_response(&text)
    }

    pub async fn heartbeat(&self, reg: &Registration, job_id: Uuid) -> Result<()> {
        let resources = self.resources.lock().sample();
        let mut payload = json!({
            "job_id": job_id,
            "extend_seconds": self.heartbeat_seconds.max(30),
            "resources": resources,
        });
        if !reg.tenant_projects.is_empty() {
            let tenants: Vec<JsonValue> = reg
                .tenant_projects
                .iter()
                .map(|project_id| {
                    json!({
                        "projectId": project_id,
                    })
                })
                .collect();
            if let Some(map) = payload.as_object_mut() {
                map.insert("tenants".to_string(), JsonValue::Array(tenants));
            }
        }

        let send = |bearer: String| {
            self.http
                .post(reg.heartbeat_url.clone())
                .header("content-type", "application/json")
                .bearer_auth(bearer)
                .json(&payload)
                .send()
        };

        let mut response = send(self.bearer_for_agent(reg))
            .await
            .context("heartbeat request failed")?;

        // A job long enough to outlive its agent token would otherwise
        // heartbeat itself to death. One renewal-and-retry, never a loop
        // (#144); a lost lease (409) is a different failure and is not
        // retried.
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            warn!(
                status = %response.status(),
                "heartbeat rejected; requesting a credential renewal"
            );
            if self.refresh_credentials_once().await {
                response = send(self.bearer_for_agent(reg))
                    .await
                    .context("heartbeat retry request failed")?;
                if response.status().is_success() {
                    info!("heartbeat recovered with a renewed agent token");
                }
            }
        }

        let status = response.status();
        if status == reqwest::StatusCode::CONFLICT {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("heartbeat lease lost: {body}"));
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!(
                "heartbeat request failed: status={} body={}",
                status,
                body
            ));
        }

        Ok(())
    }

    pub async fn poll_job_inputs(
        &self,
        registration: &Registration,
        job_id: Uuid,
        active_turn_id: &str,
    ) -> Result<Vec<AgentJobInput>> {
        let url = self
            .base_url
            .join(&format!("/agent/jobs/{job_id}/inputs"))?;
        let response = self
            .http
            .post(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .json(&AgentJobInputPollRequest { active_turn_id })
            .send()
            .await
            .context("active-turn input poll failed")?;
        let status = response.status();
        let text = response
            .text()
            .await
            .context("active-turn input poll response body")?;
        if !status.is_success() {
            return Err(anyhow!(
                "active-turn input poll failed: status={} body={}",
                status,
                text
            ));
        }
        serde_json::from_str::<AgentJobInputPollResponse>(&text)
            .map(|response| response.commands)
            .with_context(|| format!("failed to parse active-turn input poll response: {text}"))
    }

    pub(crate) async fn register_worker_input_request(
        &self,
        registration: &Registration,
        job_id: Uuid,
        request: &WorkerInputRequest,
    ) -> Result<RegisteredWorkerInputRequest> {
        let url = self
            .base_url
            .join(&format!("/agent/jobs/{job_id}/user-input-requests"))?;
        // No automatic retry: an uncertain result must not create a second question.
        // The controller owns registration idempotency and card publication.
        let response = self
            .http
            .post(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .json(&json!({
                "runtimeId": registration.runtime_id,
                "questions": request.questions,
                "continuationNote": request.continuation_note,
            }))
            .send()
            .await
            .context("worker user-input registration failed")?;
        let status = response.status();
        anyhow::ensure!(
            status.is_success(),
            "worker user-input registration rejected: status={status}"
        );
        let registered = response
            .json::<RegisteredWorkerInputRequest>()
            .await
            .context("invalid worker user-input registration response")?;
        anyhow::ensure!(
            matches!(registered.status.as_str(), "pending" | "answered"),
            "worker user-input registration returned a non-active request"
        );
        Ok(registered)
    }

    pub(crate) async fn submit_worker_input_reply(
        &self,
        registration: &Registration,
        job_id: Uuid,
        reply: &crate::jobs::worker_input_routing::Reply,
    ) -> Result<serde_json::Value> {
        let url = self
            .base_url
            .join(&format!("/agent/jobs/{job_id}/user-input-replies"))?;
        let mut body = serde_json::to_value(reply)?;
        body["runtimeId"] = json!(registration.runtime_id);
        let response = self
            .http
            .post(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .json(&body)
            .send()
            .await
            .context("worker answer routing failed")?;
        let status = response.status();
        if !status.is_success() {
            let reason = response
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|body| {
                    body.get("message")
                        .and_then(serde_json::Value::as_str)
                        .map(|value| truncate_agent_payload_text(value, 500))
                })
                .unwrap_or_else(|| "controller rejected the worker reply".to_string());
            return Err(anyhow!(
                "worker answer routing rejected: status={status}: {reason}"
            ));
        }
        let receipt: serde_json::Value = response
            .json()
            .await
            .context("invalid worker reply receipt")?;
        anyhow::ensure!(
            receipt.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
                && receipt.get("disposition") == body.get("disposition"),
            "worker reply was not accepted"
        );
        if reply.disposition == crate::jobs::worker_input_routing::Disposition::Answer {
            let accepted: Vec<Uuid> = serde_json::from_value(
                receipt
                    .get("requestIds")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .context("worker reply receipt has no request IDs")?;
            let expected = reply
                .answers
                .iter()
                .map(|answer| answer.request_id)
                .collect::<std::collections::HashSet<_>>();
            anyhow::ensure!(
                accepted.len() == expected.len()
                    && accepted
                        .into_iter()
                        .collect::<std::collections::HashSet<_>>()
                        == expected,
                "worker reply receipt did not accept every requested answer"
            );
        }
        Ok(receipt)
    }

    pub async fn clear_job_input_readiness(
        &self,
        registration: &Registration,
        job_id: Uuid,
    ) -> Result<()> {
        let url = self
            .base_url
            .join(&format!("/agent/jobs/{job_id}/inputs"))?;
        let response = self
            .http
            .delete(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .send()
            .await
            .context("active-turn input readiness clear failed")?;
        let status = response.status();
        if !status.is_success() && status != StatusCode::CONFLICT {
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "active-turn input readiness clear failed: status={} body={}",
                status,
                text
            ));
        }
        Ok(())
    }

    pub async fn acknowledge_job_input(
        &self,
        registration: &Registration,
        job_id: Uuid,
        command_id: Uuid,
        outcome: &str,
        codex_turn_id: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<()> {
        let url = self
            .base_url
            .join(&format!("/agent/jobs/{job_id}/inputs/{command_id}/ack"))?;
        let response = self
            .http
            .post(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .header("content-type", "application/json")
            .json(&AgentJobInputAckRequest {
                outcome,
                codex_turn_id,
                error_message,
            })
            .send()
            .await
            .context("active-turn input acknowledgement failed")?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "active-turn input acknowledgement failed: status={} body={}",
                status,
                text
            ));
        }
        Ok(())
    }

    pub fn poll_interval(&self) -> Duration {
        self.poll_interval
    }

    pub fn lease_wait(&self) -> Duration {
        self.lease_wait
    }

    #[allow(dead_code)]
    pub fn heartbeat_seconds(&self) -> u32 {
        self.heartbeat_seconds
    }

    pub async fn stop_runtime(
        &self,
        registration: &Registration,
        reason: Option<&str>,
    ) -> Result<()> {
        let Some(stop_url) = registration.stop_url.clone() else {
            return Ok(());
        };

        let mut payload = json!({
            "runtime_id": registration.runtime_id,
        });

        if let Some(reason) = reason {
            if let Some(map) = payload.as_object_mut() {
                map.insert("reason".to_string(), JsonValue::String(reason.to_string()));
            }
        }

        let response = self
            .http
            .post(stop_url)
            .header("content-type", "application/json")
            .bearer_auth(self.bearer_for_agent(registration))
            .json(&payload)
            .send()
            .await
            .context("runtime stop request failed")?;

        let status = response.status();

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!(
                "runtime stop request failed: status={} body={}",
                status,
                body
            ));
        }

        Ok(())
    }

    pub async fn complete_job(
        &self,
        registration: &Registration,
        job_id: Uuid,
        summary: &str,
        artifacts: &[JsonValue],
        proxy_metadata: Option<JsonValue>,
    ) -> Result<()> {
        let url = self.base_url.join("/agent/complete")?;
        let compact_artifacts = compact_completion_artifacts(artifacts);
        let mut payload = json!({
            "job_id": job_id,
            "outcome": "succeeded",
            "summary": truncate_agent_payload_text(summary, MAX_AGENT_SUMMARY_CHARS),
            "artifacts": compact_artifacts,
        });

        if let Some(metadata) = proxy_metadata {
            payload["proxy_metadata"] = compact_agent_payload_json(&metadata, 0);
        }

        self.post_agent(url, &self.bearer_for_agent(registration), payload)
            .await
    }

    pub async fn fail_job(
        &self,
        registration: &Registration,
        job_id: Uuid,
        message: &str,
        proxy_metadata: Option<JsonValue>,
    ) -> Result<()> {
        self.fail_job_with_artifacts(registration, job_id, message, &[], proxy_metadata)
            .await
    }

    pub async fn fail_job_with_artifacts(
        &self,
        registration: &Registration,
        job_id: Uuid,
        message: &str,
        artifacts: &[JsonValue],
        proxy_metadata: Option<JsonValue>,
    ) -> Result<()> {
        let url = self.base_url.join("/agent/complete")?;
        let compact_artifacts = compact_completion_artifacts(artifacts);
        let mut payload = json!({
            "job_id": job_id,
            "outcome": "failed",
            "error_message": truncate_agent_payload_text(message, MAX_AGENT_SUMMARY_CHARS),
            "artifacts": compact_artifacts,
        });

        if let Some(metadata) = proxy_metadata {
            payload["proxy_metadata"] = compact_agent_payload_json(&metadata, 0);
        }

        self.post_agent(url, &self.bearer_for_agent(registration), payload)
            .await
    }

    fn absolute_url(&self, path: &str) -> Result<Url> {
        if let Ok(url) = Url::parse(path) {
            return Ok(url);
        }
        self.base_url
            .join(path)
            .context("failed to join controller URL")
    }

    pub async fn append_job_message(
        &self,
        registration: &Registration,
        job_id: Uuid,
        content: &str,
        message_type: Option<&str>,
        metadata: Option<&JsonValue>,
    ) -> Result<()> {
        let url = self.base_url.join("/agent/message")?;
        let mut payload = json!({
            "job_id": job_id,
            "content": truncate_agent_payload_text(content, MAX_AGENT_MESSAGE_CONTENT_CHARS),
        });

        if let Some(kind) = message_type {
            if !kind.trim().is_empty() {
                payload["message_type"] = JsonValue::String(kind.trim().to_string());
            }
        }
        if let Some(meta) = metadata {
            payload["metadata"] = compact_agent_payload_json(meta, 0);
        }

        self.post_agent(url, &self.bearer_for_agent(registration), payload)
            .await
    }

    pub async fn fetch_job_secrets(
        &self,
        registration: &Registration,
        job_id: Uuid,
        touch: bool,
    ) -> Result<JobSecrets> {
        let url = self.base_url.join("/agent/secrets")?;
        let payload = json!({
            "job_id": job_id,
            "touch": touch,
        });

        let send = |bearer: String| {
            self.http
                .post(url.clone())
                .bearer_auth(bearer)
                .header("content-type", "application/json")
                .json(&payload)
                .send()
        };

        let response = send(self.bearer_for_agent(registration))
            .await
            .context("agent secrets request failed")?;

        let mut status = response.status();
        let mut text = response
            .text()
            .await
            .unwrap_or_else(|_| "<unable to read response body>".to_string());

        // The refresh loop that runs alongside a long job outlives the agent
        // token it started with. One renewal-and-retry, never a loop: if no
        // fresh credential lands the original failure is surfaced and the
        // caller's own cadence decides when to try again (#144).
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            warn!(
                %status,
                "agent secrets request rejected; requesting a credential renewal"
            );
            if self.refresh_credentials_once().await {
                let retried = send(self.bearer_for_agent(registration))
                    .await
                    .context("agent secrets retry request failed")?;
                status = retried.status();
                text = retried
                    .text()
                    .await
                    .unwrap_or_else(|_| "<unable to read response body>".to_string());
                if status.is_success() {
                    info!("agent secrets recovered with a renewed agent token");
                }
            }
        }

        if !status.is_success() {
            return Err(anyhow!(
                "agent secrets request failed: status={} body={}",
                status,
                text
            ));
        }

        let parsed: AgentSecretsResponse =
            serde_json::from_str(&text).context("failed to parse agent secrets response")?;

        let mut env = HashMap::new();
        let env_map = parsed.env.and_then(|value| value.as_object().cloned());
        if let Some(entries) = env_map {
            for (key, value) in entries {
                if let Some(text) = value.as_str() {
                    env.insert(key, text.to_string());
                }
            }
        }

        let mut inventory: Vec<AgentSecretInventoryItem> = Vec::new();
        let mut inventory_complete = parsed.inventory.is_some();
        if let Some(items) = parsed.inventory {
            for item in items {
                let name = item
                    .name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let Some(name) = name else {
                    inventory_complete = false;
                    continue;
                };
                let description = item
                    .description
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                if inventory
                    .iter()
                    .any(|existing| existing.name.eq_ignore_ascii_case(&name))
                {
                    continue;
                }
                inventory.push(AgentSecretInventoryItem { name, description });
            }
        }

        let research_budget = crate::research_budget::ResearchBudgetAccess::from_controller(
            parsed.runtime_settings.research_budget.is_some(),
            self.base_url.as_str(),
            parsed.research_budget_token,
        );
        research_budget.validate(self.base_url.as_str())?;
        Ok(JobSecrets {
            env,
            inventory,
            inventory_complete,
            research_budget,
            runtime_settings: parsed.runtime_settings,
        })
    }

    /// Fetch the durable browser profile for this project (shared scope).
    /// A 404 establishes an empty version-zero baseline. A successful response
    /// must include its version; never treat an unversioned archive as writable.
    pub async fn get_browser_profile(
        &self,
        registration: &Registration,
    ) -> Result<BrowserProfileSnapshot> {
        self.fetch_browser_profile(self.bearer_for_agent(registration))
            .await
    }

    /// [`Self::get_browser_profile`] with the freshest agent token, for the
    /// browser host, which runs outside any one registration. Fails before
    /// the first registration has landed.
    pub async fn get_browser_profile_with_current_token(&self) -> Result<BrowserProfileSnapshot> {
        let bearer = self
            .current_agent_token
            .lock()
            .clone()
            .context("no agent token yet for the browser profile fetch")?;
        self.fetch_browser_profile(bearer).await
    }

    async fn fetch_browser_profile(&self, bearer: String) -> Result<BrowserProfileSnapshot> {
        let url = self.base_url.join("/agent/browser-profile")?;
        let response = self
            .http
            .get(url)
            .bearer_auth(bearer)
            .send()
            .await
            .context("browser profile fetch request failed")?;

        let status = response.status();
        if status != StatusCode::NOT_FOUND && !status.is_success() {
            return Err(anyhow!("browser profile fetch failed: status={status}"));
        }
        anyhow::ensure!(
            response
                .headers()
                .get("x-instafy-profile-write-policy")
                .and_then(|value| value.to_str().ok())
                == Some("versioned-v2"),
            "controller does not advertise versioned browser profile writes; profile saves disabled"
        );
        if status == StatusCode::NOT_FOUND {
            return Ok(BrowserProfileSnapshot {
                version: 0,
                archive: None,
            });
        }
        let version = response
            .headers()
            .get("x-instafy-profile-version")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|version| (1..i64::MAX).contains(version))
            .context("browser profile response is missing a valid version")?;

        let bytes = response
            .bytes()
            .await
            .context("failed to read browser profile body")?;
        Ok(BrowserProfileSnapshot {
            version,
            archive: Some(bytes.to_vec()),
        })
    }

    /// Upload a fresh snapshot of the browser profile for this project. The
    /// controller encrypts it at rest and hands it to the next runtime.
    pub async fn put_browser_profile(
        &self,
        registration: &Registration,
        body: Vec<u8>,
        expected_version: i64,
    ) -> Result<i64> {
        self.put_browser_profile_classified(Some(registration), body, expected_version)
            .await
            .map_err(UploadFailure::into_error)
    }

    /// [`Self::put_browser_profile`], with the failure classified by what it
    /// means for the stored copy. Uses the freshest agent token, else the
    /// registration's; without either nothing is sent (`Rejected(401)`).
    pub async fn put_browser_profile_classified(
        &self,
        registration: Option<&Registration>,
        body: Vec<u8>,
        expected_version: i64,
    ) -> std::result::Result<i64, UploadFailure> {
        if !(0..i64::MAX).contains(&expected_version) {
            return Err(UploadFailure::Rejected(StatusCode::BAD_REQUEST));
        }
        let bearer = self
            .current_agent_token
            .lock()
            .clone()
            .or_else(|| registration.map(|registration| registration.agent_token.clone()));
        let Some(bearer) = bearer else {
            return Err(UploadFailure::Rejected(StatusCode::UNAUTHORIZED));
        };
        // Old controllers must reject this route, including a rollback after
        // GET negotiated the new protocol. Never fall back to the legacy PUT.
        let mut url = self
            .base_url
            .join("/agent/browser-profile/v2")
            .map_err(|error| UploadFailure::Uncertain(error.into()))?;
        url.query_pairs_mut()
            .append_pair("version", &expected_version.to_string());
        let response = self
            .http
            .put(url)
            .bearer_auth(bearer)
            .header("content-type", "application/octet-stream")
            .body(body)
            .send()
            .await
            .context("browser profile upload request failed")
            .map_err(UploadFailure::Uncertain)?;

        let status = response.status();
        if !status.is_success() {
            return Err(UploadFailure::from_status(status));
        }
        let manifest: BrowserProfileManifest = response
            .json()
            .await
            .context("invalid browser profile upload response")
            .map_err(UploadFailure::Uncertain)?;
        if manifest.scope != "project" || manifest.version != expected_version + 1 {
            return Err(UploadFailure::Uncertain(anyhow!(
                "browser profile upload returned an unexpected version or scope"
            )));
        }
        Ok(manifest.version)
    }

    pub async fn post_telemetry(&self, payload: JsonValue) -> Result<()> {
        let url = self.base_url.join("/telemetry")?;
        let mut request = self
            .http
            .post(url)
            .header("content-type", "application/json")
            .json(&payload);

        if let Some(token) = self.read_runtime_access_token() {
            request = request.bearer_auth(token);
        }

        let response = request.send().await.context("telemetry request failed")?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "telemetry request failed: status={} body={}",
                status,
                body
            ));
        }

        Ok(())
    }

    /// Sends a picture of a preview this runtime serves to the preview's card
    /// (`PUT /projects/:id/previews/:previewId/thumbnail`), with this
    /// runtime's own credential: the controller takes a preview's picture from
    /// the runtime and lease that serve it only, and this credential still
    /// works after the turn that changed the site has ended. A JPEG from
    /// `instafy preview check`; the controller checks its bytes again and
    /// removes any metadata. The controller keeps the picture sent last, so
    /// one tried again after a credential renewal is sent only while
    /// `still_newest` says no newer picture was taken meanwhile.
    pub async fn upload_preview_picture(
        &self,
        project_id: Uuid,
        preview_id: &str,
        image: &[u8],
        description: Option<&str>,
        still_newest: crate::jobs::preview_pictures::StillNewest<'_>,
    ) -> Result<()> {
        use base64::Engine as _;
        if !crate::jobs::preview_pictures::is_preview_id(preview_id) {
            return Err(anyhow!("not a preview id"));
        }
        if !image.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return Err(anyhow!("a preview's picture from a check is a JPEG"));
        }
        let url = self.base_url.join(&format!(
            "/projects/{project_id}/previews/{preview_id}/thumbnail"
        ))?;
        let mut body = json!({
            "image": base64::engine::general_purpose::STANDARD.encode(image),
            "contentType": "image/jpeg",
            "source": "capture",
        });
        if let Some(description) = description {
            body["description"] = JsonValue::String(description.to_string());
        }
        let send = |token: String| {
            self.http
                .put(url.clone())
                .bearer_auth(token)
                .header("content-type", "application/json")
                .json(&body)
                .send()
        };
        let token = self.read_runtime_access_token().ok_or_else(|| {
            anyhow!("this runtime has no credential to send a preview's picture with")
        })?;
        let mut response = send(token)
            .await
            .context("preview picture request failed")?;
        // A renewal may have landed since: one retry with the fresh
        // credential, never a loop, and none once a newer picture was taken
        // while it waited.
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) && self.refresh_credentials_once().await
            && let Some(token) = self.read_runtime_access_token()
        {
            if !still_newest() {
                return Err(anyhow!(
                    "a newer picture of the preview was taken while this one waited to be sent again"
                ));
            }
            response = send(token)
                .await
                .context("preview picture retry request failed")?;
        }
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "preview picture request failed: status={} body={}",
                status,
                text.chars().take(300).collect::<String>()
            ));
        }
        Ok(())
    }

    /// Claim this runtime's preview restarts (see `preview_restarts`).
    /// `Ok(None)` when the controller does not offer them (an older one, or
    /// one without previews).
    pub async fn claim_preview_restarts(
        &self,
        registration: &Registration,
    ) -> Result<Option<Vec<crate::preview_restarts::PreviewRestart>>> {
        let url = self.base_url.join("/agent/preview-restarts/claim")?;
        let response = self
            .http
            .post(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .context("preview restart claim failed")?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            return Ok(None);
        }
        if !status.is_success() {
            // The body may echo the request; keep only the status.
            return Err(anyhow!("preview restart claim failed: status={status}"));
        }
        // The claim carries tunnel credentials: never put its body in an error.
        let text = response
            .text()
            .await
            .context("preview restart claim body read failed")?;
        let claim: crate::preview_restarts::PreviewRestartClaim = serde_json::from_str(&text)
            .map_err(|error| {
                anyhow!(
                    "preview restart claim was not understood ({:?} at line {} column {})",
                    error.classify(),
                    error.line(),
                    error.column()
                )
            })?;
        Ok(Some(claim.restarts))
    }

    /// Report how a claimed preview restart ended.
    pub async fn report_preview_restart(
        &self,
        registration: &Registration,
        wake_id: Uuid,
        error: Option<&str>,
    ) -> Result<()> {
        let url = self
            .base_url
            .join(&format!("/agent/preview-restarts/{wake_id}/result"))?;
        let payload = match error {
            None => json!({ "ok": true }),
            Some(error) => json!({ "ok": false, "error": truncate_agent_payload_text(error, 500) }),
        };
        self.post_agent(url, &self.bearer_for_agent(registration), payload)
            .await
    }

    async fn post_agent(&self, url: Url, agent_token: &str, payload: JsonValue) -> Result<()> {
        let response = self
            .http
            .post(url)
            .bearer_auth(agent_token)
            .header("content-type", "application/json")
            .json(&payload)
            .send()
            .await
            .context("agent completion request failed")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "agent completion request failed: status={} body={}",
                status,
                body
            ));
        }

        Ok(())
    }
}

/// A completion's artifacts as they are sent: every list cut to its first
/// [`MAX_AGENT_METADATA_ARRAY_ITEMS`] entries and every string bounded.
pub(crate) fn compact_completion_artifacts(artifacts: &[JsonValue]) -> Vec<JsonValue> {
    artifacts
        .iter()
        .map(|artifact| compact_agent_payload_json(artifact, 0))
        .collect()
}

fn compact_agent_payload_json(value: &JsonValue, depth: usize) -> JsonValue {
    if depth >= MAX_AGENT_METADATA_DEPTH {
        return json!({
            "kind": "runtime/payload-depth-truncated",
        });
    }

    match value {
        JsonValue::String(text) => JsonValue::String(truncate_agent_payload_text(
            text,
            MAX_AGENT_METADATA_STRING_CHARS,
        )),
        JsonValue::Array(items) => {
            let mut compact = items
                .iter()
                .take(MAX_AGENT_METADATA_ARRAY_ITEMS)
                .map(|item| compact_agent_payload_json(item, depth + 1))
                .collect::<Vec<_>>();
            if items.len() > MAX_AGENT_METADATA_ARRAY_ITEMS {
                compact.push(json!({
                    "kind": "runtime/payload-array-truncated",
                    "omittedItems": items.len() - MAX_AGENT_METADATA_ARRAY_ITEMS,
                }));
            }
            JsonValue::Array(compact)
        }
        JsonValue::Object(map) => {
            let mut compact = JsonMap::new();
            for (key, item) in map {
                compact.insert(key.clone(), compact_agent_payload_json(item, depth + 1));
            }
            JsonValue::Object(compact)
        }
        other => other.clone(),
    }
}

fn truncate_agent_payload_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut chars = value.chars().rev().take(max_chars).collect::<Vec<_>>();
    chars.reverse();
    format!(
        "[payload text truncated; keeping tail]\n{}",
        chars.into_iter().collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_budget_is_advertised_only_by_the_typed_controller_response() {
        let legacy: AgentSecretsResponse = serde_json::from_value(json!({
            "env": {
                "INSTAFY_RESEARCH_SHARED": "1",
                "INSTAFY_RESEARCH_ACCESS_TOKEN": "granted-token"
            },
            "metadata": {"researchBudget": {"maxPageLoads": 200, "maxPageLoadsPerSite": 200}}
        }))
        .unwrap();
        assert!(legacy.runtime_settings.research_budget.is_none());
        assert!(legacy.research_budget_token.is_none());
        let current: AgentSecretsResponse = serde_json::from_value(json!({
            "runtimeSettings": {"researchBudget": {"maxPageLoads": 24, "maxPageLoadsPerSite": 8}},
            "researchBudgetToken": "research-only-token"
        }))
        .unwrap();
        assert!(current.runtime_settings.research_budget.is_some());
        assert_eq!(
            current.research_budget_token.as_deref(),
            Some("research-only-token")
        );
        let missing_token: AgentSecretsResponse = serde_json::from_value(json!({
            "runtimeSettings": {"researchBudget": {"maxPageLoads": 24, "maxPageLoadsPerSite": 8}}
        }))
        .unwrap();
        let mut environment = HashMap::new();
        crate::research_budget::ResearchBudgetAccess::from_controller(
            missing_token.runtime_settings.research_budget.is_some(),
            "http://127.0.0.1:8787",
            missing_token.research_budget_token,
        )
        .apply(&mut environment);
        assert_eq!(environment["INSTAFY_RESEARCH_SHARED"], "1");
        assert!(!environment.contains_key("INSTAFY_RESEARCH_ACCESS_TOKEN"));
    }

    #[test]
    fn native_subagent_limit_comes_only_from_validated_controller_settings() {
        let legacy: AgentSecretsResponse = serde_json::from_value(json!({
            "env": {"MAX_NATIVE_SUBAGENTS": "64", "runtimeSettings": "64"},
            "inventory": [{"name": "MAX_NATIVE_SUBAGENTS"}],
            "metadata": {"maxNativeSubagents": 64}
        }))
        .unwrap();
        assert_eq!(legacy.runtime_settings.max_native_subagents.get(), 3);
        let configured: AgentSecretsResponse = serde_json::from_value(json!({
            "runtimeSettings": {"maxNativeSubagents": 10},
            "env": {"MAX_NATIVE_SUBAGENTS": "64"}
        }))
        .unwrap();
        assert_eq!(configured.runtime_settings.max_native_subagents.get(), 10);
        for invalid in [
            json!(0),
            json!(65),
            json!(-1),
            json!(1.5),
            json!("10"),
            json!(null),
        ] {
            assert!(
                serde_json::from_value::<AgentSecretsResponse>(json!({
                    "runtimeSettings": {"maxNativeSubagents": invalid}
                }))
                .is_err()
            );
        }
    }

    #[test]
    fn lease_job_from_legacy_response_defaults_workspace_token_fields() {
        let job: LeaseJob = serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "intent": "apply",
            "project_id": Uuid::new_v4(),
            "run_id": Uuid::new_v4(),
            "payload": {
                "prompt_text": "Build a homepage"
            },
            "controller_token": "legacy-controller-token",
            "controller_token_scopes": ["prompt.execute"],
            "controller_token_expires_at": "2025-01-01T00:05:00Z"
        }))
        .expect("deserialize legacy lease job response");

        assert_eq!(
            job.controller_token.as_deref(),
            Some("legacy-controller-token")
        );
        assert!(job.workspace_token.is_none());
        assert!(job.workspace_token_scopes.is_none());
        assert!(job.workspace_token_expires_at.is_none());
        assert_eq!(job.lease_attempts, 0);
        assert!(!job.resumes_an_interrupted_attempt());
    }

    #[test]
    fn only_a_gone_with_the_space_deleted_code_is_a_deleted_space() {
        let body = r#"{"message":"This space was deleted.","code":"space_deleted"}"#;
        assert!(is_space_deleted_refusal(StatusCode::GONE, body));
        // A job's own calls are refused with 409; the agent stops on the
        // lease or registration that follows.
        assert!(!is_space_deleted_refusal(StatusCode::CONFLICT, body));
        assert!(!is_space_deleted_refusal(
            StatusCode::GONE,
            r#"{"message":"gone","code":"runtime_retired"}"#
        ));
        assert!(!is_space_deleted_refusal(
            StatusCode::GONE,
            r#"{"message":"gone"}"#
        ));
        assert!(!is_space_deleted_refusal(StatusCode::GONE, "space_deleted"));
    }

    #[test]
    fn a_job_leased_again_after_a_requeue_resumes_an_interrupted_attempt() {
        let lease = |attempts: i32| {
            let body = json!({
                "jobs": [{
                    "id": Uuid::new_v4(),
                    "payload": { "prompt_text": "Create ALIAS.md" },
                    "lease_attempts": attempts,
                }]
            });
            parse_lease_response(&body.to_string())
                .expect("parse lease response")
                .jobs
                .remove(0)
        };
        assert!(!lease(1).resumes_an_interrupted_attempt());
        let resumed = lease(2);
        assert_eq!(resumed.lease_attempts, 2);
        assert!(resumed.resumes_an_interrupted_attempt());
    }

    #[test]
    fn a_lease_that_fails_to_parse_keeps_its_body_out_of_the_error() {
        let marker = "lease-body-secret";
        for body in [
            // serde would quote the rejected value in its own message.
            format!(r#"{{"jobs":[{{"id":"{marker}"}}]}}"#),
            format!(
                r#"{{"jobs":[{{"id":"{}","payload":{{"attachment_downloads":[{{"url":"https://storage.invalid/x?token={marker}"}}]}},"controller_token":7}}]}}"#,
                Uuid::new_v4()
            ),
            format!(r#"{{"jobs":[{{"id":"{marker}"#),
        ] {
            let Err(LeaseError::Other(error)) = parse_lease_response(&body) else {
                panic!("{body} parsed");
            };
            let message = format!("{error:#}");
            assert!(
                message.starts_with("failed to parse lease response"),
                "{message}"
            );
            assert!(!message.contains(marker), "{message}");
            assert!(!message.contains("storage.invalid"), "{message}");
        }
        let empty = parse_lease_response(r#"{"jobs":[]}"#).unwrap();
        assert_eq!(empty.jobs.len(), 0);
        // A controller that predates waiting never says it waited.
        assert!(!empty.waited);
        assert!(
            parse_lease_response(r#"{"jobs":[],"waited":true}"#)
                .unwrap()
                .waited
        );
    }

    #[test]
    fn truncate_agent_payload_text_keeps_tail() {
        let truncated = truncate_agent_payload_text("abcdef", 3);
        assert_eq!(truncated, "[payload text truncated; keeping tail]\ndef");
    }

    #[test]
    fn compact_agent_payload_json_truncates_large_arrays_and_strings() {
        let value = json!({
            "text": "x".repeat(MAX_AGENT_METADATA_STRING_CHARS + 4),
            "items": (0..(MAX_AGENT_METADATA_ARRAY_ITEMS + 2)).collect::<Vec<_>>(),
        });

        let compact = compact_agent_payload_json(&value, 0);

        let text = compact["text"].as_str().expect("text");
        assert!(text.starts_with("[payload text truncated; keeping tail]"));
        let items = compact["items"].as_array().expect("items");
        assert_eq!(items.len(), MAX_AGENT_METADATA_ARRAY_ITEMS + 1);
        assert_eq!(
            items.last().and_then(|item| item.get("kind")),
            Some(&json!("runtime/payload-array-truncated"))
        );
    }

    /// A stand-in controller for previews' pictures: it keeps each request it
    /// gets (method, path, credential and body) and answers each with the next
    /// of its statuses, then 200.
    #[derive(Clone, Default)]
    struct PictureStandIn {
        requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String, String, JsonValue)>>>,
        statuses: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<u16>>>,
    }

    async fn picture_stand_in(
        axum::extract::State(stand_in): axum::extract::State<PictureStandIn>,
        method: axum::http::Method,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
        body: axum::body::Bytes,
    ) -> (axum::http::StatusCode, String) {
        let bearer = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let body = serde_json::from_slice(&body).unwrap_or(JsonValue::Null);
        stand_in.requests.lock().unwrap().push((
            method.to_string(),
            uri.path().to_string(),
            bearer,
            body,
        ));
        let status = stand_in.statuses.lock().unwrap().pop_front().unwrap_or(200);
        (
            axum::http::StatusCode::from_u16(status).unwrap(),
            r#"{"version":"0123456789abcdef","width":640,"height":400}"#.to_string(),
        )
    }

    async fn picture_client(
        stand_in: &PictureStandIn,
    ) -> (
        ControllerClient,
        tokio::task::JoinHandle<()>,
        tempfile::TempDir,
    ) {
        let app = axum::Router::new()
            .fallback(picture_stand_in)
            .with_state(stand_in.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url: Url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let workspace = tempfile::tempdir().unwrap();
        let config = Config {
            controller_base_url: base_url.clone(),
            controller_jwks_url: base_url.join("/.well-known/jwks.json").unwrap(),
            project_id: Uuid::new_v4(),
            runtime_id: None,
            runtime_lease_id: None,
            provider: "test-runtime".into(),
            runtime_version: "0.0.1".into(),
            capabilities: json!({}),
            metadata: json!({}),
            lease_scope: None,
            workspace_manifest: None,
            tenant_projects: Vec::new(),
            parent_lease_id: None,
            poll_interval: Duration::from_millis(10),
            lease_wait: Duration::ZERO,
            lease_max_jobs: 1,
            lease_seconds: 120,
            heartbeat_seconds: 60,
            workspace_root: workspace.path().to_path_buf(),
            project_workspace_override: None,
            strict_mode: false,
            dev_isolation_mode: true,
            display_name: None,
            origin: None,
            codex_bin: None,
            require_codex_bin: false,
            runtime_access_token: Some("runtime-token".into()),
            parent_dispositions_runtime_on_shutdown: false,
        };
        (ControllerClient::new(&config).unwrap(), server, workspace)
    }

    // A turn's end sends an open preview's new picture with this runtime's own
    // credential, after the turn's reply, when the turn's own no longer
    // works: to the preview's picture, as the JPEG a check took, with the
    // page's description. A picture that is not a JPEG, or a preview id that
    // is not plain, goes nowhere. A credential the controller refuses is
    // renewed and the picture sent again once, never more, and not at all
    // when a newer picture was taken while it waited.
    #[tokio::test]
    async fn a_preview_picture_goes_to_its_card_with_the_runtimes_own_credential() {
        use base64::Engine as _;
        let stand_in = PictureStandIn::default();
        let (client, server, _workspace) = picture_client(&stand_in).await;
        let project = Uuid::new_v4();
        let jpeg = b"\xFF\xD8\xFF\xE0card".to_vec();
        let newest = || true;
        let requests = || std::mem::take(&mut *stand_in.requests.lock().unwrap());
        let refuse_next = |statuses: &[u16]| stand_in.statuses.lock().unwrap().extend(statuses);
        // Publishes a renewed credential once the client asks for one.
        let renew = |token: &'static str| {
            let store = client.runtime_token_handle();
            tokio::spawn(async move {
                store.refresh_requested().await;
                store.store(token.to_string());
            })
        };

        client
            .upload_preview_picture(project, "tun_01-map", &jpeg, Some("Trip · 3 days"), &newest)
            .await
            .unwrap();
        assert_eq!(
            requests(),
            vec![(
                "PUT".to_string(),
                format!("/projects/{project}/previews/tun_01-map/thumbnail"),
                "Bearer runtime-token".to_string(),
                json!({
                    "image": base64::engine::general_purpose::STANDARD.encode(&jpeg),
                    "contentType": "image/jpeg",
                    "source": "capture",
                    "description": "Trip · 3 days",
                }),
            )]
        );

        for (preview, image) in [
            ("tun_01-map", b"\x89PNG\r\n\x1a\ncard".to_vec()),
            ("../agent/complete", jpeg.clone()),
        ] {
            assert!(
                client
                    .upload_preview_picture(project, preview, &image, None, &newest)
                    .await
                    .is_err()
            );
        }
        assert!(requests().is_empty());

        // Refused, renewed, sent again once with the renewed credential.
        refuse_next(&[401]);
        let renewal = renew("renewed-token");
        client
            .upload_preview_picture(project, "tun_01-map", &jpeg, None, &newest)
            .await
            .unwrap();
        renewal.await.unwrap();
        let bearers: Vec<String> = requests().into_iter().map(|request| request.2).collect();
        assert_eq!(
            bearers,
            vec!["Bearer runtime-token", "Bearer renewed-token"]
        );

        // Refused again after the renewal: no loop.
        refuse_next(&[403, 401]);
        let renewal = renew("third-token");
        assert!(
            client
                .upload_preview_picture(project, "tun_01-map", &jpeg, None, &newest)
                .await
                .is_err()
        );
        renewal.await.unwrap();
        assert_eq!(requests().len(), 2);

        // A newer picture was taken while it waited for the renewal: not sent
        // again over it.
        refuse_next(&[401]);
        let renewal = renew("fourth-token");
        let newer_since = || false;
        assert!(
            client
                .upload_preview_picture(project, "tun_01-map", &jpeg, None, &newer_since)
                .await
                .is_err()
        );
        renewal.await.unwrap();
        assert_eq!(requests().len(), 1);
        server.abort();
    }
}
