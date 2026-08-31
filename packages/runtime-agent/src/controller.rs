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
use crate::resources::ResourceSampler;
use runtime_contracts::ProxyEnvelopePayload;

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
const MAX_AGENT_METADATA_ARRAY_ITEMS: usize = 80;
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
    lease_max_jobs: u32,
    lease_seconds: u32,
    #[allow(dead_code)]
    heartbeat_seconds: u32,
    agent_tokens: AgentTokenVerifier,
    resources: Mutex<ResourceSampler>,
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
}

#[derive(Debug, Deserialize)]
struct LeaseResponse {
    jobs: Vec<LeaseJob>,
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

#[derive(Debug, Deserialize)]
struct AgentSecretsResponse {
    env: Option<JsonValue>,
    inventory: Option<Vec<AgentSecretInventoryItemResponse>>,
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
}

#[derive(Debug)]
pub enum LeaseError {
    Unauthorized,
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
            lease_max_jobs: config.lease_max_jobs,
            lease_seconds: config.lease_seconds,
            heartbeat_seconds: config.heartbeat_seconds,
            agent_tokens: AgentTokenVerifier::new(config.controller_jwks_url.clone()),
            resources: Mutex::new(ResourceSampler::new(config.workspace_root.clone())),
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

    pub async fn lease_once(&self, reg: &Registration) -> Result<Vec<LeaseJob>, LeaseError> {
        let request = self
            .http
            .post(reg.lease_url.clone())
            .header("content-type", "application/json")
            .bearer_auth(self.bearer_for_agent(reg));

        let resources = self.resources.lock().sample();
        let payload = json!({
            "runtime_id": reg.runtime_id,
            "max": self.lease_max_jobs,
            "lease_seconds": self.lease_seconds,
            "resources": resources,
            "supports_workspace_token": true,
        });

        let response = request
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

        if !status.is_success() {
            return Err(LeaseError::Other(anyhow!(
                "lease request failed: status={} body={}",
                status,
                text
            )));
        }

        let parsed: LeaseResponse = serde_json::from_str(&text).map_err(|error| {
            LeaseError::Other(anyhow!(
                "failed to parse lease response: {error}; body={}",
                text
            ))
        })?;
        Ok(parsed.jobs)
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
        let compact_artifacts = artifacts
            .iter()
            .map(|artifact| compact_agent_payload_json(artifact, 0))
            .collect::<Vec<_>>();
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
        let compact_artifacts = artifacts
            .iter()
            .map(|artifact| compact_agent_payload_json(artifact, 0))
            .collect::<Vec<_>>();
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
        if let Some(items) = parsed.inventory {
            for item in items {
                let name = item
                    .name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let Some(name) = name else {
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

        Ok(JobSecrets { env, inventory })
    }

    /// Fetch the durable browser profile for this project (shared scope).
    /// Returns `Ok(None)` when nothing is stored yet (404), which the caller
    /// treats as "start from a blank profile". The body is the decrypted,
    /// packed profile archive (the controller holds it encrypted at rest).
    pub async fn get_browser_profile(
        &self,
        registration: &Registration,
    ) -> Result<Option<Vec<u8>>> {
        let url = self.base_url.join("/agent/browser-profile")?;
        let response = self
            .http
            .get(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .send()
            .await
            .context("browser profile fetch request failed")?;

        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "browser profile fetch failed: status={} body={}",
                status,
                body
            ));
        }

        let bytes = response
            .bytes()
            .await
            .context("failed to read browser profile body")?;
        Ok(Some(bytes.to_vec()))
    }

    /// Upload a fresh snapshot of the browser profile for this project. The
    /// controller encrypts it at rest and hands it to the next runtime.
    pub async fn put_browser_profile(
        &self,
        registration: &Registration,
        body: Vec<u8>,
    ) -> Result<()> {
        let url = self.base_url.join("/agent/browser-profile")?;
        let response = self
            .http
            .put(url)
            .bearer_auth(self.bearer_for_agent(registration))
            .header("content-type", "application/octet-stream")
            .body(body)
            .send()
            .await
            .context("browser profile upload request failed")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "browser profile upload failed: status={} body={}",
                status,
                body
            ));
        }
        Ok(())
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
}
