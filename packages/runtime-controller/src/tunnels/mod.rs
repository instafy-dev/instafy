use std::str::FromStr;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client as PgClient, Row};
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::active_job_auth::{authorize_active_job_if_scoped, ActiveJobProjectAccess};
use crate::auth::{authenticate_request, bearer_token, claims_have_scopes, RequestContext};
use crate::bug_reports::{record_system_bug_report, SystemBugReportInput};
use crate::config::{AppConfig, PgPool, SelfHostedTunnelConfig};
use crate::credits::process_credit_burn;
use crate::org_limits;
use crate::projects::{
    ensure_project_access, ensure_project_org, ensure_project_write_access, load_project_record,
};
#[cfg(test)]
use crate::runtime::RUNTIME_TOKEN_DEFAULT_SCOPES;
use crate::runtime::{ensure_runtime_generation_matches, RUNTIME_TOKEN_REQUIRED_SCOPES};
use crate::state::publish_controller_event;
use crate::tokens::decode_scoped_token;
use crate::{
    bad_request, forbidden, internal_error, not_found, parse_optional_uuid_param, unauthorized,
    ApiError, AppState,
};

const ACTIVE_JOB_TUNNEL_METADATA_KEY: &str = "_instafyActiveJob";
const ACTIVE_JOB_TUNNEL_SOURCE: &str = "instafy-cli";

#[derive(Clone, Copy, Debug)]
struct ActiveJobTunnelBinding {
    job_id: Uuid,
    run_id: Uuid,
    runtime_id: Uuid,
    runtime_lease_id: Option<Uuid>,
}

#[derive(Clone, Copy, Debug)]
struct RuntimeMachineTunnelBinding {
    runtime_id: Uuid,
    runtime_lease_id: Option<Uuid>,
}

#[derive(Clone, Copy, Debug)]
struct RuntimeTunnelGenerationState<'a> {
    private_self_hosted: bool,
    status: &'a str,
    active_lease_id: Option<Uuid>,
    lease_project_id: Option<Uuid>,
    lease_runtime_id: Option<Uuid>,
    lease_status: Option<&'a str>,
    lease_released: bool,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TunnelProvider {
    SelfHosted,
}

impl TunnelProvider {
    #[allow(dead_code)]
    pub(crate) fn as_str(&self) -> &'static str {
        "self_hosted"
    }
}

fn tunnel_billing_bucket(now: DateTime<Utc>, interval_seconds: i64) -> i64 {
    let interval = interval_seconds.max(1);
    now.timestamp() / interval
}

fn generate_idempotency_key(
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    purpose: Option<&str>,
    interval_seconds: i64,
) -> String {
    if let (Some(runtime_id), Some(lease_id)) = (runtime_id, lease_id) {
        let bucket = tunnel_billing_bucket(Utc::now(), interval_seconds);
        if let Some(purpose) = purpose.and_then(normalize_tunnel_purpose) {
            return format!("runtime_tunnel:{runtime_id}:{lease_id}:{purpose}:{bucket}");
        }
        return format!("runtime_tunnel:{runtime_id}:{lease_id}:{bucket}");
    }

    if let Some(purpose) = purpose.and_then(normalize_tunnel_purpose) {
        return format!("project_tunnel:{project_id}:{purpose}");
    }

    format!("project_tunnel:{}:{}", project_id, Uuid::new_v4())
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct TunnelRequestContext {
    pub(crate) project_id: Uuid,
    pub(crate) runtime_id: Option<Uuid>,
    pub(crate) lease_id: Option<Uuid>,
    pub(crate) purpose: Option<String>,
    pub(crate) org_id: Option<Uuid>,
    pub(crate) idempotency_key: Option<String>,
    pub(crate) expires_in_seconds: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelAssignment {
    pub(crate) provider: TunnelProvider,
    pub(crate) tunnel_id: String,
    pub(crate) hostname: String,
    pub(crate) url: String,
    pub(crate) status: String,
    pub(crate) credentials: JsonValue,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) metadata: Option<JsonValue>,
}

#[async_trait]
pub(crate) trait TunnelBroker: Send + Sync {
    fn provider_kind(&self) -> TunnelProvider;
    async fn request_tunnel(&self, ctx: TunnelRequestContext) -> Result<TunnelAssignment>;
    #[allow(dead_code)]
    async fn revoke_tunnel(&self, tunnel_id: &str, metadata: Option<&JsonValue>) -> Result<()>;
}

pub(crate) type DynTunnelBroker = Arc<dyn TunnelBroker>;

pub(crate) struct SelfHostedTunnelBroker {
    config: SelfHostedTunnelConfig,
    http: Client,
    credit_burn_interval_seconds: i64,
    credit_burn_lead_seconds: i64,
}

impl SelfHostedTunnelBroker {
    pub(crate) fn new(
        config: SelfHostedTunnelConfig,
        http: Client,
        credit_burn_interval_seconds: i64,
        credit_burn_lead_seconds: i64,
    ) -> Self {
        Self {
            config,
            http,
            credit_burn_interval_seconds,
            credit_burn_lead_seconds,
        }
    }

    fn base(&self, path: &str) -> String {
        format!("{}{}", self.config.base_url, path)
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.bearer_auth(&self.config.api_token)
            .header(header::USER_AGENT, "instafy-runtime-controller")
    }
}

#[derive(Debug, Deserialize)]
struct BrokerTunnelResponse {
    tunnel: BrokerTunnelDescriptor,
    #[serde(default)]
    credit: Option<BrokerCreditSnapshot>,
}

#[derive(Debug, Deserialize)]
struct BrokerTunnelDescriptor {
    #[serde(rename = "tunnel_id")]
    tunnel_id: Uuid,
    hostname: String,
    status: String,
    #[serde(default)]
    #[allow(dead_code)]
    ingress_host: String,
    #[serde(default)]
    #[allow(dead_code)]
    ingress_port: u16,
    #[allow(dead_code)]
    token: String,
    #[serde(default)]
    token_expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    metadata: Option<JsonValue>,
    client: BrokerClientConfig,
}

#[derive(Debug, Deserialize)]
struct BrokerClientConfig {
    server: String,
    token: String,
    hostname: String,
    #[serde(default)]
    service: Option<String>,
    #[serde(default)]
    remote_port: Option<u16>,
}

#[derive(Debug, Deserialize, Serialize)]
struct BrokerCreditSnapshot {
    balance: i32,
    credit_limit: i32,
    #[serde(default)]
    balance_after: Option<i32>,
}

#[async_trait]
impl TunnelBroker for SelfHostedTunnelBroker {
    fn provider_kind(&self) -> TunnelProvider {
        TunnelProvider::SelfHosted
    }

    async fn request_tunnel(&self, ctx: TunnelRequestContext) -> Result<TunnelAssignment> {
        let interval_seconds = self.credit_burn_interval_seconds.max(1);
        let lead_seconds = self.credit_burn_lead_seconds.max(0);
        let expires_in_seconds = ctx
            .expires_in_seconds
            .unwrap_or(interval_seconds + lead_seconds)
            .max(1);
        let idempotency_key = ctx.idempotency_key.unwrap_or_else(|| {
            generate_idempotency_key(
                ctx.project_id,
                ctx.runtime_id,
                ctx.lease_id,
                ctx.purpose.as_deref(),
                interval_seconds,
            )
        });
        let body = json!({
            "project_id": ctx.project_id,
            "org_id": ctx.org_id,
            "runtime_id": ctx.runtime_id,
            "lease_id": ctx.lease_id,
            "idempotency_key": idempotency_key,
            "expires_in_seconds": expires_in_seconds,
        });

        let response = self
            .auth(self.http.post(self.base("/tunnels")))
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            let body_text = String::from_utf8_lossy(&bytes);
            anyhow::bail!(
                "tunnel broker request failed ({} {}): {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("unknown"),
                body_text
            );
        }
        let resp: BrokerTunnelResponse = serde_json::from_slice(&bytes)
            .map_err(|error| anyhow::anyhow!("failed to parse tunnel broker response: {error}"))?;

        let tunnel = resp.tunnel;
        let expires_at = tunnel
            .expires_at
            .or(tunnel.token_expires_at)
            .unwrap_or_else(|| Utc::now() + ChronoDuration::seconds(interval_seconds));
        let url = tunnel
            .url
            .unwrap_or_else(|| format!("https://{}", tunnel.hostname));
        let mut credentials = json!({
            "provider": TunnelProvider::SelfHosted.as_str(),
            "server": tunnel.client.server,
            "token": tunnel.client.token,
            "hostname": tunnel.client.hostname,
        });
        if let Some(map) = credentials.as_object_mut() {
            if let Some(service) = tunnel.client.service.as_ref() {
                map.insert("service".to_string(), json!(service));
                map.insert("serviceName".to_string(), json!(service));
            }
            if let Some(port) = tunnel.client.remote_port {
                map.insert("remotePort".to_string(), json!(port));
            }
        }

        let mut metadata = tunnel.metadata.unwrap_or_else(|| json!({}));
        if let Some(credit) = resp.credit {
            let credit_value = serde_json::to_value(credit).unwrap_or(json!({}));
            match metadata.as_object_mut() {
                Some(map) => {
                    map.insert("credit".to_string(), credit_value);
                }
                None => {
                    metadata = json!({ "credit": credit_value });
                }
            }
        }

        Ok(TunnelAssignment {
            provider: TunnelProvider::SelfHosted,
            tunnel_id: tunnel.tunnel_id.to_string(),
            hostname: tunnel.hostname,
            url,
            status: tunnel.status,
            credentials,
            expires_at,
            metadata: Some(metadata),
        })
    }

    async fn revoke_tunnel(&self, tunnel_id: &str, _metadata: Option<&JsonValue>) -> Result<()> {
        let path = format!("/tunnels/{tunnel_id}");
        let response = self.auth(self.http.delete(self.base(&path))).send().await?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            let body_text = String::from_utf8_lossy(&bytes);
            anyhow::bail!(
                "tunnel broker revoke failed ({} {}): {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("unknown"),
                body_text
            );
        }
        Ok(())
    }
}

pub(crate) fn build_tunnel_broker(
    config: &AppConfig,
    http: Client,
) -> Result<Option<DynTunnelBroker>> {
    if let Some(self_hosted) = config.self_hosted_tunnel_broker.clone() {
        let broker = SelfHostedTunnelBroker::new(
            self_hosted,
            http.clone(),
            config.tunnel_credit_burn_interval_seconds,
            config.tunnel_credit_burn_lead_seconds,
        );
        return Ok(Some(Arc::new(broker)));
    }

    Ok(None)
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/tunnel-broker/hooks/acl",
            post(post_tunnel_broker_acl_hook),
        )
        .route(
            "/tunnel-broker/hooks/events",
            post(post_tunnel_broker_event_hook),
        )
        .route(
            "/projects/:project_id/tunnels/request",
            post(post_tunnel_request),
        )
        .route(
            "/projects/:project_id/tunnels",
            get(get_project_tunnel_grants),
        )
        .route(
            "/projects/:project_id/tunnels/:tunnel_id/revoke",
            post(post_tunnel_revoke),
        )
        .route(
            "/projects/:project_id/tunnels/:tunnel_id/status",
            post(post_tunnel_status),
        )
}

#[derive(Debug, Deserialize)]
struct TunnelRequestPathParams {
    project_id: String,
}

#[derive(Debug, Deserialize)]
struct TunnelListPathParams {
    project_id: String,
}

#[derive(Debug, Deserialize)]
struct TunnelRevokePathParams {
    project_id: String,
    tunnel_id: String,
}

#[derive(Debug, Deserialize)]
struct TunnelBrokerAclPayload {
    intent: String,
    #[serde(rename = "project_id")]
    project_id: String,
    #[serde(default)]
    org_id: Option<String>,
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    lease_id: Option<String>,
    #[serde(default, alias = "idempotencyKey")]
    idempotency_key: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
struct TunnelBrokerAclResponse {
    allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TunnelBrokerEventPayload {
    kind: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    org_id: Option<String>,
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    lease_id: Option<String>,
    #[serde(default)]
    data: Option<JsonValue>,
}

fn validate_tunnel_broker_event_kind(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let kind = raw.trim();
    if kind.len() <= "tunnel.".len()
        || kind.len() > 128
        || !kind.starts_with("tunnel.")
        || !kind
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(bad_request(
            "tunnel broker event kind must be a bounded tunnel.* identifier",
        ));
    }
    Ok(kind.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelRequestBody {
    #[serde(rename = "runtimeId", alias = "runtime_id")]
    runtime_id: Option<String>,
    #[serde(rename = "runtimeLeaseId", alias = "runtime_lease_id")]
    runtime_lease_id: Option<String>,
    #[serde(default)]
    purpose: Option<String>,
    #[serde(default, rename = "localPort", alias = "local_port")]
    local_port: Option<u16>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Deserialize, Default)]
struct TunnelRevokeBody {
    metadata: Option<JsonValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStatusBody {
    status: String,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelGrantResponse {
    id: Uuid,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    runtime_lease_id: Option<Uuid>,
    provider: String,
    tunnel_id: String,
    hostname: String,
    url: String,
    status: String,
    expires_at: String,
    metadata: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credentials: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelGrantListResponse {
    project_id: Uuid,
    grants: Vec<TunnelGrantResponse>,
}

pub(crate) async fn request_runtime_tunnel(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: Option<&Uuid>,
    runtime_lease_id: Option<&Uuid>,
    request_metadata: Option<JsonValue>,
) -> Result<TunnelGrantResponse, (StatusCode, Json<ApiError>)> {
    tracing::warn!(
        project_id = %project_id,
        runtime_id = ?runtime_id,
        runtime_lease_id = ?runtime_lease_id,
        "requesting runtime tunnel"
    );
    let broker = state.tunnel_broker.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("tunnel broker is not configured")),
        )
    })?;

    let provider_kind = broker.provider_kind();
    let runtime_uuid = runtime_id.copied();
    let entitlement_details = ensure_tunnel_entitlement(
        state,
        project_id,
        runtime_uuid,
        runtime_lease_id.copied(),
        &provider_kind,
    )
    .await?;
    let org_id = entitlement_details
        .get("orgId")
        .and_then(JsonValue::as_str)
        .and_then(|s| Uuid::parse_str(s).ok());

    let now = Utc::now();
    let interval_seconds = state.config.tunnel_credit_burn_interval_seconds.max(1);
    let refresh_lead_seconds = state.config.tunnel_credit_burn_lead_seconds.max(0);
    let broker_expires_in_seconds = interval_seconds + refresh_lead_seconds;
    let purpose = request_metadata
        .as_ref()
        .and_then(extract_tunnel_purpose_from_metadata);
    let local_port = request_metadata
        .as_ref()
        .and_then(extract_local_port_from_metadata);
    let broker_idempotency_key = if matches!(provider_kind, TunnelProvider::SelfHosted) {
        match (runtime_uuid, runtime_lease_id.copied()) {
            (Some(runtime_id), Some(lease_id)) => {
                let lease_started_at =
                    load_runtime_lease_started_at(&state.pool, project_id, &lease_id).await?;
                let started_at = lease_started_at.unwrap_or(now);
                let bucket = tunnel_usage_bucket(now, started_at, interval_seconds);
                Some(tunnel_billing_idempotency_key(
                    runtime_id,
                    lease_id,
                    purpose.as_deref(),
                    bucket,
                ))
            }
            _ => None,
        }
    } else {
        None
    };

    let mut assignment = broker
        .request_tunnel(TunnelRequestContext {
            project_id: *project_id,
            runtime_id: runtime_uuid,
            lease_id: runtime_lease_id.copied(),
            purpose: purpose.clone(),
            org_id,
            idempotency_key: broker_idempotency_key,
            expires_in_seconds: matches!(provider_kind, TunnelProvider::SelfHosted)
                .then_some(broker_expires_in_seconds),
        })
        .await
        .map_err(|error| internal_error(format!("failed to request tunnel: {error}")))?;

    if let Some(local_port) = local_port {
        inject_local_port_into_credentials(&mut assignment.credentials, local_port);
    }
    if let Some(purpose) = purpose.as_deref() {
        inject_purpose_into_credentials(&mut assignment.credentials, purpose);
    }

    let provider_metadata = assignment.metadata.clone();
    let ledger_metadata = compose_tunnel_metadata(
        request_metadata.as_ref(),
        Some(&entitlement_details),
        provider_metadata.as_ref(),
    );

    let grant = insert_runtime_tunnel_grant(
        &state.pool,
        project_id,
        runtime_uuid,
        runtime_lease_id.copied(),
        assignment.provider.as_str(),
        &assignment.tunnel_id,
        &assignment.hostname,
        &assignment.url,
        &assignment.status,
        assignment.expires_at,
        ledger_metadata.as_ref(),
    )
    .await?;
    tracing::warn!(
        project_id = %grant.project_id,
        runtime_id = ?grant.runtime_id,
        runtime_lease_id = ?grant.runtime_lease_id,
        tunnel_id = %grant.tunnel_id,
        hostname = %grant.hostname,
        "tunnel grant recorded"
    );

    publish_controller_event(
        &state.events,
        "tunnel.grant_requested",
        Some(*project_id),
        None,
        None,
        None,
        tunnel_event_payload(&grant),
    );

    Ok(tunnel_response_from_record(
        &grant,
        Some(assignment.credentials),
    ))
}

#[instrument(skip(state, headers, body))]
async fn post_tunnel_request(
    State(state): State<AppState>,
    Path(params): Path<TunnelRequestPathParams>,
    headers: HeaderMap,
    Json(body): Json<TunnelRequestBody>,
) -> Result<Json<TunnelGrantResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;

    let requested_runtime_id = body
        .runtime_id
        .as_ref()
        .map(|value| parse_required_uuid(value, "runtimeId"))
        .transpose()?;
    let requested_runtime_lease_id = body
        .runtime_lease_id
        .as_ref()
        .map(|value| parse_required_uuid(value, "runtimeLeaseId"))
        .transpose()?;

    let context = authenticate_request(&state.config, &headers, None).await?;
    let mut human_runtime_id = requested_runtime_id;
    let active_job_binding = if let Some(claims) = context.scoped_claims.as_ref() {
        if claims_have_scopes(claims, RUNTIME_TOKEN_REQUIRED_SCOPES) {
            let binding =
                authorize_live_runtime_machine_tunnel(&state, claims, &project_id).await?;
            ensure_runtime_machine_tunnel_target(
                &binding,
                requested_runtime_id,
                requested_runtime_lease_id,
            )?;
            None
        } else {
            ensure_active_job_tunnel_request_semantics(&body)?;
            Some(authorize_active_job_tunnel(&state, &context, &project_id).await?)
        }
    } else {
        ensure_project_write_authorized(&state, &project_id, &context).await?;
        human_runtime_id = resolve_canonical_tunnel_runtime_id(
            &state,
            &project_id,
            requested_runtime_id,
            requested_runtime_lease_id,
        )
        .await?;
        if requested_runtime_lease_id.is_some()
            && (requested_runtime_id.is_none() || requested_runtime_id != human_runtime_id)
        {
            return Err(bad_request(
                "runtimeId must exactly match runtimeLeaseId for tunnel requests",
            ));
        }
        if let Some(runtime_id) = human_runtime_id {
            ensure_private_runtime_access(&state, &project_id, &runtime_id, &context).await?;
        }
        None
    };

    let runtime_id = active_job_binding
        .map(|binding| binding.runtime_id)
        .or(human_runtime_id);
    let runtime_lease_id = active_job_binding
        .and_then(|binding| binding.runtime_lease_id)
        .or(requested_runtime_lease_id);
    if let Some(binding) = active_job_binding {
        ensure_active_job_requested_binding(
            &binding,
            requested_runtime_id,
            requested_runtime_lease_id,
        )?;
    }

    let mut metadata_map = body.metadata;
    if let Some(JsonValue::Object(map)) = metadata_map.as_mut() {
        map.remove(ACTIVE_JOB_TUNNEL_METADATA_KEY);
    }
    if body
        .purpose
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || body.local_port.is_some()
    {
        if !metadata_map
            .as_ref()
            .map(|value| value.is_object())
            .unwrap_or(false)
        {
            metadata_map = Some(json!({}));
        }
        if let Some(JsonValue::Object(map)) = metadata_map.as_mut() {
            if let Some(purpose) = body
                .purpose
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                map.entry("purpose".to_string())
                    .or_insert_with(|| JsonValue::String(purpose));
            }
            if let Some(port) = body.local_port {
                map.entry("localPort".to_string())
                    .or_insert_with(|| JsonValue::from(port));
            }
        }
    }
    if let Some(binding) = active_job_binding {
        if !metadata_map
            .as_ref()
            .map(JsonValue::is_object)
            .unwrap_or(false)
        {
            metadata_map = Some(json!({}));
        }
        if let Some(JsonValue::Object(map)) = metadata_map.as_mut() {
            map.insert(
                ACTIVE_JOB_TUNNEL_METADATA_KEY.to_string(),
                json!({
                    "jobId": binding.job_id,
                    "runId": binding.run_id,
                    "runtimeId": binding.runtime_id,
                    "runtimeLeaseId": binding.runtime_lease_id,
                }),
            );
        }
    }

    let response = request_runtime_tunnel(
        &state,
        &project_id,
        runtime_id.as_ref(),
        runtime_lease_id.as_ref(),
        metadata_map,
    )
    .await?;

    Ok(Json(response))
}

#[instrument(skip(state, headers))]
async fn get_project_tunnel_grants(
    State(state): State<AppState>,
    Path(params): Path<TunnelListPathParams>,
    headers: HeaderMap,
) -> Result<Json<TunnelGrantListResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;

    let auth = authenticate_request(&state.config, &headers, None).await?;
    ensure_project_authorized(&state, &project_id, &auth).await?;

    let grants = fetch_runtime_tunnel_grants(&state.pool, &project_id).await?;
    let mut visible_grants = Vec::with_capacity(grants.len());
    for grant in grants {
        if let Some(runtime_id) = resolve_canonical_tunnel_runtime_id(
            &state,
            &project_id,
            grant.runtime_id,
            grant.runtime_lease_id,
        )
        .await?
        {
            match ensure_private_runtime_access(&state, &project_id, &runtime_id, &auth).await {
                Ok(()) => {}
                Err((StatusCode::FORBIDDEN | StatusCode::NOT_FOUND, _)) => continue,
                Err(error) => return Err(error),
            }
        }
        visible_grants.push(grant);
    }
    let payload = TunnelGrantListResponse {
        project_id,
        grants: visible_grants
            .iter()
            .map(|grant| tunnel_response_from_record(grant, None))
            .collect(),
    };

    Ok(Json(payload))
}

#[instrument(skip(state, headers, body))]
async fn post_tunnel_revoke(
    State(state): State<AppState>,
    Path(params): Path<TunnelRevokePathParams>,
    headers: HeaderMap,
    Json(body): Json<Option<TunnelRevokeBody>>,
) -> Result<Json<TunnelGrantResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let tunnel_id = params.tunnel_id.trim();
    if tunnel_id.is_empty() {
        return Err(bad_request("tunnelId is required"));
    }

    let context = authenticate_request(&state.config, &headers, None).await?;
    let (active_job_binding, runtime_machine_binding) =
        if let Some(claims) = context.scoped_claims.as_ref() {
            if claims_have_scopes(claims, RUNTIME_TOKEN_REQUIRED_SCOPES) {
                (
                    None,
                    Some(authorize_live_runtime_machine_tunnel(&state, claims, &project_id).await?),
                )
            } else {
                (
                    Some(authorize_active_job_tunnel(&state, &context, &project_id).await?),
                    None,
                )
            }
        } else {
            ensure_project_write_authorized(&state, &project_id, &context).await?;
            (None, None)
        };

    let existing = load_runtime_tunnel_grant_by_tunnel_id(&state.pool, &project_id, tunnel_id)
        .await?
        .ok_or_else(|| not_found("tunnel grant not found"))?;

    if context.scoped_claims.is_none() {
        if let Some(runtime_id) = resolve_canonical_tunnel_runtime_id(
            &state,
            &project_id,
            existing.runtime_id,
            existing.runtime_lease_id,
        )
        .await?
        {
            ensure_private_runtime_access(&state, &project_id, &runtime_id, &context).await?;
        }
    }

    if context.scoped_claims.is_some() {
        if let Some(binding) = active_job_binding {
            ensure_scoped_tunnel_runtime_match(
                Some(binding.runtime_id.to_string().as_str()),
                existing.runtime_id,
            )?;
            ensure_scoped_tunnel_lease_match(
                binding
                    .runtime_lease_id
                    .map(|value| value.to_string())
                    .as_deref(),
                existing.runtime_lease_id,
            )?;
            ensure_active_job_tunnel_ownership(existing.metadata.as_ref(), &binding)?;
        } else if let Some(binding) = runtime_machine_binding {
            ensure_runtime_machine_tunnel_target(
                &binding,
                existing.runtime_id,
                existing.runtime_lease_id,
            )?;
        }
    }

    let metadata_override = body.and_then(|payload| payload.metadata);
    let updated = revoke_tunnel_record(&state, existing, metadata_override.as_ref()).await?;

    Ok(Json(tunnel_response_from_record(&updated, None)))
}

#[instrument(skip(state, headers, body))]
async fn post_tunnel_status(
    State(state): State<AppState>,
    Path(params): Path<TunnelRevokePathParams>,
    headers: HeaderMap,
    Json(body): Json<TunnelStatusBody>,
) -> Result<Json<TunnelGrantResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let tunnel_id = params.tunnel_id.trim();
    if tunnel_id.is_empty() {
        return Err(bad_request("tunnelId is required"));
    }

    let status_value = body.status.trim();
    if status_value.is_empty() {
        return Err(bad_request("status is required"));
    }

    let scoped_claims = bearer_token(&headers)
        .and_then(|token| decode_scoped_token(&state.config, &token, "runtime token").ok())
        .filter(|claims| claims_have_scopes(claims, RUNTIME_TOKEN_REQUIRED_SCOPES));

    let runtime_machine_binding = if let Some(claims) = scoped_claims.as_ref() {
        Some(authorize_live_runtime_machine_tunnel(&state, claims, &project_id).await?)
    } else {
        let auth = authenticate_request(&state.config, &headers, None).await?;
        if !auth.is_service_role {
            return Err(unauthorized("tunnel status requires service role"));
        }
        None
    };

    let existing = load_runtime_tunnel_grant_by_tunnel_id(&state.pool, &project_id, tunnel_id)
        .await?
        .ok_or_else(|| not_found("tunnel grant not found"))?;

    if let Some(binding) = runtime_machine_binding {
        ensure_runtime_machine_tunnel_target(
            &binding,
            existing.runtime_id,
            existing.runtime_lease_id,
        )?;
    }

    let updated = match update_tunnel_status_record(
        &state.pool,
        &existing,
        status_value,
        body.metadata.as_ref(),
    )
    .await
    {
        Ok(record) => record,
        Err(error) => {
            warn!(
                project_id = %project_id,
                tunnel_id = %tunnel_id,
                status = status_value,
                ?error,
                "failed to update tunnel status"
            );
            return Err(error);
        }
    };

    publish_controller_event(
        &state.events,
        "tunnel.status_updated",
        Some(project_id),
        None,
        None,
        None,
        tunnel_event_payload(&updated),
    );

    Ok(Json(tunnel_response_from_record(&updated, None)))
}

#[instrument(skip(state, headers, payload))]
async fn post_tunnel_broker_acl_hook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TunnelBrokerAclPayload>,
) -> Result<Json<TunnelBrokerAclResponse>, (StatusCode, Json<ApiError>)> {
    authorize_hook(&headers, state.config.tunnel_broker_hook_secret.as_ref())?;

    let project_id = parse_required_uuid(&payload.project_id, "project_id")?;
    let org_id_param = parse_optional_uuid_param(payload.org_id.clone(), "org_id")?;
    let burn_amount = state.config.tunnel_credit_burn_amount.max(0);
    let idempotency_key = payload
        .idempotency_key
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    if burn_amount > 0 && idempotency_key.is_none() {
        return Ok(Json(TunnelBrokerAclResponse {
            allowed: false,
            reason: Some("idempotency_key is required for tunnel credit burns".to_string()),
        }));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;
    let project = ensure_project_org(&transaction, &project).await?;
    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;

    if let Some(requested_org) = org_id_param {
        if requested_org != org_id {
            transaction.commit().await.ok(); // nothing to persist on mismatch
            return Ok(Json(TunnelBrokerAclResponse {
                allowed: false,
                reason: Some("org mismatch".to_string()),
            }));
        }
    }

    if burn_amount > 0 {
        let runtime_id = parse_optional_uuid_param(payload.runtime_id.clone(), "runtime_id")?;
        let mut metadata = json!({
            "feature": "tunnel.grant",
            "source": "tunnel-broker-hook",
            "intent": payload.intent,
        });
        let burn_result = process_credit_burn(
            &transaction,
            &project_id,
            &org_id,
            runtime_id,
            burn_amount,
            "tunnel_grant",
            idempotency_key,
            &mut metadata,
        )
        .await;

        match burn_result {
            Ok(_) => {
                transaction
                    .commit()
                    .await
                    .map_err(|error| internal_error(format!("failed to commit burn: {error}")))?;
                return Ok(Json(TunnelBrokerAclResponse {
                    allowed: true,
                    reason: None,
                }));
            }
            Err((status, Json(err))) if status == StatusCode::BAD_REQUEST => {
                transaction.rollback().await.ok();
                return Ok(Json(TunnelBrokerAclResponse {
                    allowed: false,
                    reason: Some(err.message),
                }));
            }
            Err((status, Json(err))) => {
                transaction.rollback().await.ok();
                warn!(
                    project_id = %project_id,
                    org_id = %org_id,
                    status = status.as_u16(),
                    error = %err.message,
                    "tunnel broker acl hook: credit burn failed; allowing tunnel without burn"
                );
                return Ok(Json(TunnelBrokerAclResponse {
                    allowed: true,
                    reason: Some("credit burn skipped".to_string()),
                }));
            }
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit acl check: {error}")))?;

    Ok(Json(TunnelBrokerAclResponse {
        allowed: true,
        reason: None,
    }))
}

#[instrument(skip(state, headers, payload))]
async fn post_tunnel_broker_event_hook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TunnelBrokerEventPayload>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    authorize_hook(&headers, state.config.tunnel_broker_hook_secret.as_ref())?;
    // Event visibility treats `tunnel.*` as runtime-sensitive. Never let even
    // an authenticated broker relabel tunnel/runtime payloads into a generic
    // project event that bypasses the private-runtime delivery filter.
    let event_kind = validate_tunnel_broker_event_kind(&payload.kind)?;

    let project_id = payload
        .project_id
        .as_deref()
        .map(|value| parse_required_uuid(value, "project_id"))
        .transpose()?;
    let org_id = parse_optional_uuid_param(payload.org_id.clone(), "org_id")?;
    let runtime_id = parse_optional_uuid_param(payload.runtime_id.clone(), "runtime_id")?;
    let lease_id = parse_optional_uuid_param(payload.lease_id.clone(), "lease_id")?;

    publish_controller_event(
        &state.events,
        &event_kind,
        project_id,
        org_id,
        runtime_id,
        lease_id,
        sanitize_tunnel_broadcast_data(payload.data.unwrap_or_else(|| json!({}))),
    );

    Ok(Json(json!({ "status": "ok" })))
}

#[derive(Clone, Debug)]
struct RuntimeTunnelGrantRecord {
    id: Uuid,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    runtime_lease_id: Option<Uuid>,
    provider: String,
    tunnel_id: String,
    hostname: String,
    url: String,
    status: String,
    expires_at: DateTime<Utc>,
    metadata: Option<JsonValue>,
}

async fn insert_runtime_tunnel_grant(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: Option<Uuid>,
    runtime_lease_id: Option<Uuid>,
    provider: &str,
    tunnel_id: &str,
    hostname: &str,
    url: &str,
    status: &str,
    expires_at: DateTime<Utc>,
    metadata: Option<&JsonValue>,
) -> Result<RuntimeTunnelGrantRecord, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;

    let normalized_status = normalize_tunnel_status(status);

    if let Some(runtime_id) = runtime_id.as_ref() {
        ensure_runtime_stub(&*connection, project_id, runtime_id).await?;
    }
    if let Some(runtime_lease_id) = runtime_lease_id.as_ref() {
        ensure_runtime_lease_stub(
            &*connection,
            project_id,
            runtime_id.as_ref(),
            runtime_lease_id,
        )
        .await?;
    }

    let metadata_param = metadata.cloned();
    let row = match connection
        .query_one(
            "insert into runtime_tunnel_grants
             (project_id, runtime_id, runtime_lease_id, provider, tunnel_id, hostname, url, status, expires_at, metadata)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             on conflict (tunnel_id) do update
               set project_id = excluded.project_id,
                   runtime_id = excluded.runtime_id,
                   runtime_lease_id = excluded.runtime_lease_id,
                   provider = excluded.provider,
                   hostname = excluded.hostname,
                   url = excluded.url,
                   status = excluded.status,
                   expires_at = excluded.expires_at,
                   metadata = coalesce(excluded.metadata, runtime_tunnel_grants.metadata)
             returning *",
            &[
                project_id,
                &runtime_id,
                &runtime_lease_id,
                &provider,
                &tunnel_id,
                &hostname,
                &url,
                &normalized_status,
                &expires_at,
                &metadata_param,
            ],
        )
        .await
    {
        Ok(row) => Some(row),
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                warn!(
                    project_id = %project_id,
                    tunnel_id = %tunnel_id,
                    "runtime_tunnel_grants table is missing; tunnel grants will not be persisted"
                );
                None
            } else {
                return Err(internal_error(format!("failed to insert tunnel grant: {error}")));
            }
        }
    };

    if let Some(row) = row.as_ref() {
        return Ok(runtime_tunnel_grant_from_row(row));
    }

    Ok(RuntimeTunnelGrantRecord {
        id: Uuid::new_v4(),
        project_id: *project_id,
        runtime_id,
        runtime_lease_id,
        provider: provider.to_string(),
        tunnel_id: tunnel_id.to_string(),
        hostname: hostname.to_string(),
        url: url.to_string(),
        status: normalized_status,
        expires_at,
        metadata: metadata_param,
    })
}

async fn ensure_runtime_stub(
    connection: &PgClient,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    connection
        .execute(
            "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
             values ($1, $2, 'external', 'ready', 600, now())
             on conflict (id) do nothing",
            &[runtime_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to ensure runtime record: {error}")))?;
    Ok(())
}

async fn ensure_runtime_lease_stub(
    connection: &PgClient,
    project_id: &Uuid,
    runtime_id: Option<&Uuid>,
    lease_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let runtime_param = runtime_id.copied();
    connection
        .execute(
            "insert into runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
             values ($1, $2, $3, 'active', now(), now())
             on conflict (id) do nothing",
            &[lease_id, project_id, &runtime_param],
        )
        .await
        .map_err(|error| internal_error(format!("failed to ensure runtime lease record: {error}")))?;
    Ok(())
}

fn tunnel_usage_bucket(
    now: DateTime<Utc>,
    started_at: DateTime<Utc>,
    interval_seconds: i64,
) -> i64 {
    let interval = interval_seconds.max(1);
    let elapsed_seconds = now.signed_duration_since(started_at).num_seconds().max(0);
    elapsed_seconds / interval
}

fn tunnel_billing_idempotency_key(
    runtime_id: Uuid,
    lease_id: Uuid,
    purpose: Option<&str>,
    bucket: i64,
) -> String {
    if let Some(purpose) = purpose.and_then(normalize_tunnel_purpose) {
        return format!("runtime_tunnel:{runtime_id}:{lease_id}:{purpose}:{bucket}");
    }
    format!("runtime_tunnel:{runtime_id}:{lease_id}:{bucket}")
}

async fn load_runtime_lease_started_at(
    pool: &PgPool,
    project_id: &Uuid,
    lease_id: &Uuid,
) -> Result<Option<DateTime<Utc>>, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = connection
        .query_opt(
            "select coalesce(launched_at, requested_at) as started_at
             from runtime_leases
             where id = $1 and project_id = $2
             limit 1",
            &[lease_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load runtime lease start: {error}")))?;
    Ok(row.map(|row| row.get::<_, DateTime<Utc>>("started_at")))
}

async fn update_tunnel_status_record(
    pool: &PgPool,
    record: &RuntimeTunnelGrantRecord,
    status: &str,
    metadata_override: Option<&JsonValue>,
) -> Result<RuntimeTunnelGrantRecord, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;

    let normalized_status = normalize_tunnel_status(status);
    let metadata_param = metadata_override.cloned();
    let row = connection
        .query_one(
            "update runtime_tunnel_grants
             set status = $1,
                 metadata = coalesce($2, metadata),
                 updated_at = now()
             where id = $3
             returning *",
            &[&normalized_status, &metadata_param, &record.id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update tunnel status: {error:?}")))?;

    Ok(runtime_tunnel_grant_from_row(&row))
}

async fn fetch_runtime_tunnel_grants(
    pool: &PgPool,
    project_id: &Uuid,
) -> Result<Vec<RuntimeTunnelGrantRecord>, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let rows = match connection
        .query(
            "select * from runtime_tunnel_grants
             where project_id = $1
             order by created_at desc",
            &[project_id],
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(vec![]);
            }
            return Err(internal_error(format!(
                "failed to query tunnel grants: {error}"
            )));
        }
    };
    Ok(rows.iter().map(runtime_tunnel_grant_from_row).collect())
}

async fn load_runtime_tunnel_grant_by_tunnel_id(
    pool: &PgPool,
    project_id: &Uuid,
    tunnel_id: &str,
) -> Result<Option<RuntimeTunnelGrantRecord>, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = match connection
        .query_opt(
            "select * from runtime_tunnel_grants
             where project_id = $1 and tunnel_id = $2
             limit 1",
            &[project_id, &tunnel_id],
        )
        .await
    {
        Ok(row) => row,
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(None);
            }
            return Err(internal_error(format!(
                "failed to load tunnel grant: {error}"
            )));
        }
    };
    Ok(row.map(|r| runtime_tunnel_grant_from_row(&r)))
}

pub(crate) async fn project_has_active_runtime_tunnel_hostname(
    pool: &PgPool,
    project_id: &Uuid,
    hostname: &str,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let normalized_hostname = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    if normalized_hostname.is_empty() {
        return Ok(false);
    }

    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = match connection
        .query_opt(
            "select status
             from runtime_tunnel_grants
             where project_id = $1
               and lower(hostname) = $2
             order by created_at desc
             limit 1",
            &[project_id, &normalized_hostname],
        )
        .await
    {
        Ok(row) => row,
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(false);
            }
            return Err(internal_error(format!(
                "failed to load tunnel grant by hostname: {error}"
            )));
        }
    };

    Ok(row
        .map(|row| tunnel_status_is_active(row.get::<_, String>("status").as_str()))
        .unwrap_or(false))
}

async fn update_runtime_tunnel_grant_status(
    pool: &PgPool,
    grant_id: &Uuid,
    project_id: &Uuid,
    status: &str,
    metadata: Option<&JsonValue>,
) -> Result<RuntimeTunnelGrantRecord, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let metadata_param = metadata.cloned();
    let row = connection
        .query_opt(
            "update runtime_tunnel_grants
             set status = $1,
                 metadata = coalesce($2, metadata),
                 updated_at = now()
             where id = $3
               and project_id = $4
             returning *",
            &[&status, &metadata_param, grant_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update tunnel grant: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("tunnel grant not found"));
    };
    Ok(runtime_tunnel_grant_from_row(&row))
}

fn runtime_tunnel_grant_from_row(row: &Row) -> RuntimeTunnelGrantRecord {
    RuntimeTunnelGrantRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        runtime_id: row.get("runtime_id"),
        runtime_lease_id: row.get("runtime_lease_id"),
        provider: row.get("provider"),
        tunnel_id: row.get("tunnel_id"),
        hostname: row.get("hostname"),
        url: row.get("url"),
        status: row.get("status"),
        expires_at: row.get("expires_at"),
        metadata: row.get("metadata"),
    }
}

pub(crate) async fn revoke_tunnels_for_scope(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: Option<&Uuid>,
    runtime_lease_id: Option<&Uuid>,
    source: &str,
) -> Result<usize, (StatusCode, Json<ApiError>)> {
    if runtime_id.is_none() && runtime_lease_id.is_none() {
        return Ok(0);
    }
    let grants = fetch_runtime_tunnel_grants(&state.pool, project_id).await?;
    let mut revoked = 0usize;
    for grant in grants {
        if !tunnel_status_is_active(&grant.status) {
            continue;
        }
        if let Some(target_runtime) = runtime_id {
            if grant.runtime_id.as_ref() != Some(target_runtime) {
                continue;
            }
        } else if let Some(target_lease) = runtime_lease_id {
            if grant.runtime_lease_id.as_ref() != Some(target_lease) {
                continue;
            }
        } else {
            continue;
        }

        let mut metadata_override = grant.metadata.clone();
        if !metadata_override
            .as_ref()
            .map(|value| value.is_object())
            .unwrap_or(false)
        {
            metadata_override = Some(JsonValue::Object(JsonMap::new()));
        }
        if let Some(JsonValue::Object(map)) = metadata_override.as_mut() {
            map.insert(
                "autoRevokedSource".to_string(),
                JsonValue::String(source.to_string()),
            );
            map.insert(
                "autoRevokedAt".to_string(),
                JsonValue::String(Utc::now().to_rfc3339()),
            );
        }

        if let Err(error) = revoke_tunnel_record(state, grant, metadata_override.as_ref()).await {
            return Err(error);
        }
        revoked += 1;
    }

    Ok(revoked)
}

fn normalize_tunnel_status(raw: &str) -> String {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "requested" | "refreshing" | "issuing" => "issuing".to_string(),
        "active" => "active".to_string(),
        "revoking" => "revoking".to_string(),
        "revoked" => "revoked".to_string(),
        "error" | "failed" => "failed".to_string(),
        "expired" => "expired".to_string(),
        _ => "active".to_string(),
    }
}

fn normalize_tunnel_purpose(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut normalized = String::with_capacity(trimmed.len().min(64));
    for ch in trimmed.chars() {
        if normalized.len() >= 48 {
            break;
        }
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() || lower == '_' || lower == '-' {
            normalized.push(lower);
        } else {
            normalized.push('_');
        }
    }

    let normalized = normalized.trim_matches('_').to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn extract_tunnel_purpose_from_metadata(metadata: &JsonValue) -> Option<String> {
    let obj = metadata.as_object()?;
    let candidate = obj
        .get("purpose")
        .or_else(|| obj.get("tunnelPurpose"))
        .or_else(|| obj.get("tunnel_purpose"))
        .or_else(|| obj.get("kind"))
        .and_then(JsonValue::as_str)?;
    normalize_tunnel_purpose(candidate)
}

fn extract_local_port_from_metadata(metadata: &JsonValue) -> Option<u16> {
    let obj = metadata.as_object()?;
    let value = obj
        .get("localPort")
        .or_else(|| obj.get("local_port"))
        .or_else(|| obj.get("port"))?;

    let parsed = match value {
        JsonValue::Number(num) => num.as_u64().and_then(|value| u16::try_from(value).ok()),
        JsonValue::String(raw) => raw.trim().parse::<u16>().ok(),
        _ => None,
    }?;

    if parsed == 0 {
        None
    } else {
        Some(parsed)
    }
}

fn inject_local_port_into_credentials(credentials: &mut JsonValue, local_port: u16) {
    if local_port == 0 {
        return;
    }

    if !credentials.is_object() {
        *credentials = json!({ "credentials": credentials, "localPort": local_port });
        return;
    }

    if let Some(map) = credentials.as_object_mut() {
        map.insert("localPort".to_string(), JsonValue::from(local_port));
    }
}

fn inject_purpose_into_credentials(credentials: &mut JsonValue, purpose: &str) {
    let Some(normalized) = normalize_tunnel_purpose(purpose) else {
        return;
    };

    if !credentials.is_object() {
        *credentials = json!({ "credentials": credentials, "purpose": normalized });
        return;
    }

    if let Some(map) = credentials.as_object_mut() {
        map.insert("purpose".to_string(), JsonValue::String(normalized));
    }
}

async fn revoke_tunnel_record(
    state: &AppState,
    record: RuntimeTunnelGrantRecord,
    metadata_override: Option<&JsonValue>,
) -> Result<RuntimeTunnelGrantRecord, (StatusCode, Json<ApiError>)> {
    if let Some(broker) = state.tunnel_broker.clone() {
        if let Err(error) = broker
            .revoke_tunnel(&record.tunnel_id, record.metadata.as_ref())
            .await
        {
            warn!(
                project_id = %record.project_id,
                tunnel_id = %record.tunnel_id,
                ?error,
                "tunnel broker revoke failed"
            );
        }
    }

    let updated = update_runtime_tunnel_grant_status(
        &state.pool,
        &record.id,
        &record.project_id,
        "revoked",
        metadata_override,
    )
    .await?;

    publish_controller_event(
        &state.events,
        "tunnel.grant_revoked",
        Some(record.project_id),
        None,
        None,
        None,
        tunnel_event_payload(&updated),
    );

    Ok(updated)
}

fn tunnel_status_is_active(status: &str) -> bool {
    let normalized = status.trim().to_ascii_lowercase();
    !matches!(normalized.as_str(), "revoked" | "expired" | "failed")
}

fn tunnel_response_from_record(
    record: &RuntimeTunnelGrantRecord,
    credentials: Option<JsonValue>,
) -> TunnelGrantResponse {
    TunnelGrantResponse {
        id: record.id,
        project_id: record.project_id,
        runtime_id: record.runtime_id,
        runtime_lease_id: record.runtime_lease_id,
        provider: record.provider.clone(),
        tunnel_id: record.tunnel_id.clone(),
        hostname: record.hostname.clone(),
        url: record.url.clone(),
        status: record.status.clone(),
        expires_at: record.expires_at.to_rfc3339(),
        metadata: record.metadata.clone(),
        credentials,
    }
}

fn tunnel_event_payload(record: &RuntimeTunnelGrantRecord) -> JsonValue {
    let mut data = serde_json::Map::new();
    data.insert("id".to_string(), json!(record.id));
    data.insert("projectId".to_string(), json!(record.project_id));
    if let Some(runtime_id) = record.runtime_id {
        data.insert("runtimeId".to_string(), json!(runtime_id));
    }
    if let Some(lease_id) = record.runtime_lease_id {
        data.insert("runtimeLeaseId".to_string(), json!(lease_id));
    }
    data.insert("provider".to_string(), json!(record.provider.clone()));
    data.insert("tunnelId".to_string(), json!(record.tunnel_id.clone()));
    data.insert("hostname".to_string(), json!(record.hostname.clone()));
    data.insert("url".to_string(), json!(record.url.clone()));
    data.insert("status".to_string(), json!(record.status.clone()));
    data.insert(
        "expiresAt".to_string(),
        json!(record.expires_at.to_rfc3339()),
    );
    sanitize_tunnel_broadcast_data(JsonValue::Object(data))
}

fn sanitize_tunnel_broadcast_data(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(entries) => JsonValue::Object(
            entries
                .into_iter()
                .filter_map(|(key, value)| {
                    (!tunnel_broadcast_key_is_sensitive(&key))
                        .then(|| (key, sanitize_tunnel_broadcast_data(value)))
                })
                .collect(),
        ),
        JsonValue::Array(entries) => JsonValue::Array(
            entries
                .into_iter()
                .map(sanitize_tunnel_broadcast_data)
                .collect(),
        ),
        scalar => scalar,
    }
}

fn tunnel_broadcast_key_is_sensitive(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || matches!(
            normalized.as_str(),
            "authorization" | "credentials" | "apikey" | "metadata"
        )
}

async fn ensure_private_runtime_access(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection =
        state.pool.get().await.map_err(|error| {
            internal_error(format!("failed to validate tunnel runtime: {error}"))
        })?;
    let row = connection
        .query_opt(
            "select provider, capabilities
             from runtimes
             where id = $1 and project_id = $2",
            &[runtime_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to validate tunnel runtime owner: {error}"))
        })?;
    let Some(row) = row else {
        return Err(not_found("runtime not found for project"));
    };
    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    crate::runtime::ensure_self_hosted_runtime_access(
        state,
        &provider,
        &capabilities,
        context.user_id,
        context.is_service_role,
    )
}

async fn resolve_canonical_tunnel_runtime_id(
    state: &AppState,
    project_id: &Uuid,
    requested_runtime_id: Option<Uuid>,
    runtime_lease_id: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(runtime_lease_id) = runtime_lease_id else {
        return Ok(requested_runtime_id);
    };
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to validate tunnel runtime lease: {error}"))
    })?;
    let row = connection
        .query_opt(
            "select project_id, runtime_id
             from runtime_leases
             where id = $1",
            &[&runtime_lease_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to resolve tunnel runtime lease: {error}"))
        })?;
    let Some(row) = row else {
        return Err(not_found("runtime lease not found"));
    };
    if row.get::<_, Uuid>("project_id") != *project_id {
        return Err(forbidden("runtime lease does not belong to project"));
    }
    let lease_runtime_id: Option<Uuid> = row.get("runtime_id");
    if requested_runtime_id.is_some() && requested_runtime_id != lease_runtime_id {
        return Err(forbidden(
            "runtimeId does not match the requested runtime lease",
        ));
    }
    Ok(lease_runtime_id)
}

async fn authorize_live_runtime_machine_tunnel(
    state: &AppState,
    claims: &runtime_contracts::AccessTokenClaims,
    project_id: &Uuid,
) -> Result<RuntimeMachineTunnelBinding, (StatusCode, Json<ApiError>)> {
    if !claims_have_scopes(claims, RUNTIME_TOKEN_REQUIRED_SCOPES) {
        return Err(unauthorized("runtime machine token required"));
    }
    if claims.project_id != project_id.to_string() {
        return Err(unauthorized("runtime token project mismatch"));
    }
    let runtime_id = claims
        .runtime_id
        .as_deref()
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| unauthorized("runtime token is missing a valid runtimeId"))?;
    let runtime_lease_id = claims
        .lease_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value.trim())
                .map_err(|_| unauthorized("runtime token has an invalid runtime lease scope"))
        })
        .transpose()?;
    if claims.aud != project_id.to_string() && claims.aud != runtime_id.to_string() {
        return Err(unauthorized("runtime token audience mismatch"));
    }

    let connection =
        state.pool.get().await.map_err(|error| {
            internal_error(format!("failed to validate tunnel runtime: {error}"))
        })?;
    let row = connection
        .query_opt(
            "select r.provider, r.status, r.capabilities, r.active_lease_id,
                    rl.project_id as lease_project_id,
                    rl.runtime_id as lease_runtime_id,
                    rl.status as lease_status,
                    rl.released_at as lease_released_at
             from runtimes r
             left join runtime_leases rl on rl.id = r.active_lease_id
             where r.id = $1 and r.project_id = $2",
            &[&runtime_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate tunnel runtime generation: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Err(unauthorized(
            "runtime token is not registered for this project",
        ));
    };

    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let lease_status: Option<String> = row.get("lease_status");
    let capabilities: JsonValue = row.get("capabilities");
    if crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities) {
        ensure_runtime_generation_matches(&capabilities, claims)?;
        let token_owner = Uuid::parse_str(claims.sub.trim()).ok();
        if crate::runtime::self_hosted_owner_user_id(&capabilities) != token_owner {
            return Err(unauthorized(
                "runtime token does not belong to the self-hosted runtime owner",
            ));
        }
    }
    ensure_runtime_tunnel_generation_is_live(
        project_id,
        &runtime_id,
        runtime_lease_id,
        RuntimeTunnelGenerationState {
            private_self_hosted: crate::runtime::runtime_is_private_self_hosted(
                state,
                &provider,
                &capabilities,
            ),
            status: &status,
            active_lease_id: row.get("active_lease_id"),
            lease_project_id: row.get("lease_project_id"),
            lease_runtime_id: row.get("lease_runtime_id"),
            lease_status: lease_status.as_deref(),
            lease_released: row
                .get::<_, Option<DateTime<Utc>>>("lease_released_at")
                .is_some(),
        },
    )?;

    Ok(RuntimeMachineTunnelBinding {
        runtime_id,
        runtime_lease_id,
    })
}

fn ensure_runtime_tunnel_generation_is_live(
    project_id: &Uuid,
    runtime_id: &Uuid,
    token_lease_id: Option<Uuid>,
    state: RuntimeTunnelGenerationState<'_>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if token_lease_id != state.active_lease_id {
        return Err(unauthorized(
            "runtime token runtime lease scope is no longer active",
        ));
    }

    let provider_managed = !state.private_self_hosted;
    if provider_managed && state.active_lease_id.is_none() {
        return Err(unauthorized(
            "provider-managed runtime is missing its lease scope",
        ));
    }

    // Self-hosted runtimes have no allocator lease. Their stable signed token
    // generation is checked against controller-owned capabilities before this
    // state check; live status remains an independent lifecycle fence.

    if state.active_lease_id.is_some()
        && (state.lease_project_id != Some(*project_id)
            || state.lease_runtime_id != Some(*runtime_id)
            || state.lease_status != Some("active")
            || state.lease_released)
    {
        return Err(unauthorized(
            "runtime token runtime lease scope is no longer active",
        ));
    }

    if !matches!(state.status, "ready" | "running") {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError::new("runtime is not active")),
        ));
    }

    Ok(())
}

fn ensure_runtime_machine_tunnel_target(
    binding: &RuntimeMachineTunnelBinding,
    target_runtime_id: Option<Uuid>,
    target_runtime_lease_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if target_runtime_id != Some(binding.runtime_id) {
        return Err(unauthorized("runtime token runtime mismatch"));
    }
    if target_runtime_lease_id != binding.runtime_lease_id {
        return Err(unauthorized("runtime token runtime lease mismatch"));
    }
    Ok(())
}

fn ensure_scoped_tunnel_runtime_match(
    claimed_runtime_id: Option<&str>,
    target_runtime_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let claimed_runtime_id = claimed_runtime_id
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .ok_or_else(|| unauthorized("runtime token is missing a valid runtimeId"))?;
    let target_runtime_id = target_runtime_id
        .ok_or_else(|| unauthorized("tunnel operation requires a runtime-bound target"))?;
    if claimed_runtime_id != target_runtime_id {
        return Err(unauthorized("runtime token runtime mismatch"));
    }
    Ok(())
}

fn ensure_scoped_tunnel_lease_match(
    claimed_runtime_lease_id: Option<&str>,
    target_runtime_lease_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(claimed_runtime_lease_id) = claimed_runtime_lease_id else {
        // Runtime tokens issued before generation binding did not carry a lease
        // claim. Keep those already-running runtimes compatible, while tokens
        // that do carry a generation may never cross it.
        return Ok(());
    };
    let claimed_runtime_lease_id = Uuid::parse_str(claimed_runtime_lease_id)
        .map_err(|_| unauthorized("runtime token has an invalid runtime lease scope"))?;
    if target_runtime_lease_id != Some(claimed_runtime_lease_id) {
        return Err(unauthorized("runtime token runtime lease mismatch"));
    }
    Ok(())
}

fn ensure_active_job_tunnel_request_semantics(
    body: &TunnelRequestBody,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if body.local_port.filter(|port| *port > 0).is_none() {
        return Err(bad_request(
            "active job tunnel requests require an explicit localPort",
        ));
    }
    if body
        .purpose
        .as_deref()
        .and_then(normalize_tunnel_purpose)
        .is_none()
    {
        return Err(bad_request(
            "active job tunnel requests require an explicit purpose",
        ));
    }
    let metadata = body
        .metadata
        .as_ref()
        .and_then(JsonValue::as_object)
        .ok_or_else(|| bad_request("active job tunnel requests require metadata"))?;
    if metadata.get("source").and_then(JsonValue::as_str) != Some(ACTIVE_JOB_TUNNEL_SOURCE) {
        return Err(unauthorized(
            "active job tunnel requests must use the Instafy CLI",
        ));
    }
    if metadata.get("localPort").and_then(JsonValue::as_u64) != body.local_port.map(u64::from) {
        return Err(bad_request(
            "active job tunnel request localPort metadata mismatch",
        ));
    }
    Ok(())
}

fn ensure_active_job_requested_binding(
    binding: &ActiveJobTunnelBinding,
    requested_runtime_id: Option<Uuid>,
    requested_runtime_lease_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if requested_runtime_id.is_some_and(|runtime_id| runtime_id != binding.runtime_id) {
        return Err(unauthorized("job token runtime mismatch"));
    }
    if requested_runtime_lease_id.is_some_and(|lease_id| Some(lease_id) != binding.runtime_lease_id)
    {
        return Err(unauthorized("job token runtime lease mismatch"));
    }
    Ok(())
}

fn ensure_active_job_tunnel_ownership(
    metadata: Option<&JsonValue>,
    binding: &ActiveJobTunnelBinding,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let marker = metadata
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get(ACTIVE_JOB_TUNNEL_METADATA_KEY))
        .and_then(JsonValue::as_object)
        .ok_or_else(|| unauthorized("job token cannot revoke a tunnel it did not create"))?;
    let marker_job_id = marker
        .get("jobId")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    let marker_run_id = marker
        .get("runId")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    if marker_job_id != Some(binding.job_id) || marker_run_id != Some(binding.run_id) {
        return Err(unauthorized(
            "job token cannot revoke a tunnel created by another job",
        ));
    }
    Ok(())
}

async fn authorize_active_job_tunnel(
    state: &AppState,
    context: &RequestContext,
    project_id: &Uuid,
) -> Result<ActiveJobTunnelBinding, (StatusCode, Json<ApiError>)> {
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("active job token required"))?;
    let runtime_id = claims
        .runtime_id
        .as_deref()
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| unauthorized("job token is missing a valid runtime scope"))?;
    let run_id = claims
        .run_id
        .as_deref()
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| unauthorized("job token is missing a valid run scope"))?;
    let runtime_lease_id = claims
        .lease_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value.trim())
                .map_err(|_| unauthorized("job token has an invalid runtime lease scope"))
        })
        .transpose()?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start job tunnel check: {error}")))?;
    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        context,
        ActiveJobProjectAccess::Write,
    )
    .await?
    .ok_or_else(|| unauthorized("active job token required"))?;
    active_job.ensure_project_id(project_id)?;
    let job_id = active_job.job_id;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize job tunnel check: {error}")))?;

    Ok(ActiveJobTunnelBinding {
        job_id,
        run_id,
        runtime_id,
        runtime_lease_id,
    })
}

async fn ensure_tunnel_entitlement(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: Option<Uuid>,
    runtime_lease_id: Option<Uuid>,
    provider: &TunnelProvider,
) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start entitlement check: {error}")))?;

    let project = load_project_record(&transaction, project_id).await?;
    let project = ensure_project_org(&transaction, &project).await?;
    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;

    let mut entitlement = JsonMap::new();
    entitlement.insert(
        "status".to_string(),
        JsonValue::String("allowed".to_string()),
    );
    entitlement.insert("projectId".to_string(), json!(project_id));
    entitlement.insert("orgId".to_string(), json!(org_id));
    entitlement.insert(
        "reason".to_string(),
        JsonValue::String("tunnel_grant".to_string()),
    );
    if let Some(runtime_id) = runtime_id {
        entitlement.insert("runtimeId".to_string(), json!(runtime_id));
    }
    if let Some(runtime_lease_id) = runtime_lease_id {
        entitlement.insert("runtimeLeaseId".to_string(), json!(runtime_lease_id));
    }

    let limits = org_limits::resolve_org_resource_limits(&transaction, &org_id).await?;
    entitlement.insert(
        "planId".to_string(),
        JsonValue::String(limits.subscription.plan_id.to_ascii_lowercase()),
    );
    entitlement.insert(
        "subscriptionStatus".to_string(),
        JsonValue::String(limits.subscription.status.to_ascii_lowercase()),
    );
    entitlement.insert(
        "subscriptionProcessor".to_string(),
        JsonValue::String(limits.subscription.processor.to_ascii_lowercase()),
    );

    entitlement.insert(
        "maxActiveTunnelsDefault".to_string(),
        JsonValue::from(limits.defaults.max_active_tunnels),
    );
    if let Some(override_value) = limits.overrides.max_active_tunnels {
        entitlement.insert(
            "maxActiveTunnelsOverride".to_string(),
            JsonValue::from(override_value),
        );
    }

    let max_active_tunnels = limits.max_active_tunnels;
    entitlement.insert(
        "maxActiveTunnels".to_string(),
        JsonValue::from(max_active_tunnels),
    );

    // These tunnel usage checks are best-effort. The controller should still be able to grant a
    // tunnel even if the grants table is missing or temporarily unavailable (pre-launch; no
    // migrations required).
    let tunnel_slot_exists = if let Some(runtime_lease_id) = runtime_lease_id {
        let _ = transaction
            .execute("savepoint tunnel_slot_exists_lease", &[])
            .await;
        match transaction
            .query_opt(
                "select 1
                 from runtime_tunnel_grants
                 where project_id in (select id from projects where org_id = $1)
                   and provider = 'self_hosted'
                   and expires_at > now()
                   and status in ('issuing','active','revoking')
                   and runtime_lease_id = $2
                 limit 1",
                &[&org_id, &runtime_lease_id],
            )
            .await
        {
            Ok(row) => {
                let _ = transaction
                    .execute("release savepoint tunnel_slot_exists_lease", &[])
                    .await;
                row.is_some()
            }
            Err(error) => {
                let _ = transaction
                    .execute("rollback to savepoint tunnel_slot_exists_lease", &[])
                    .await;
                let _ = transaction
                    .execute("release savepoint tunnel_slot_exists_lease", &[])
                    .await;
                let code = error.as_db_error().map(|db_error| db_error.code());
                if !matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                    warn!(
                        org_id = %org_id,
                        runtime_lease_id = %runtime_lease_id,
                        error = ?error,
                        "tunnel lease usage check failed; continuing without enforcing slot existence"
                    );
                }
                false
            }
        }
    } else if let Some(runtime_id) = runtime_id {
        let _ = transaction
            .execute("savepoint tunnel_slot_exists_runtime", &[])
            .await;
        match transaction
            .query_opt(
                "select 1
                 from runtime_tunnel_grants
                 where project_id in (select id from projects where org_id = $1)
                   and provider = 'self_hosted'
                   and expires_at > now()
                   and status in ('issuing','active','revoking')
                   and runtime_id = $2
                 limit 1",
                &[&org_id, &runtime_id],
            )
            .await
        {
            Ok(row) => {
                let _ = transaction
                    .execute("release savepoint tunnel_slot_exists_runtime", &[])
                    .await;
                row.is_some()
            }
            Err(error) => {
                let _ = transaction
                    .execute("rollback to savepoint tunnel_slot_exists_runtime", &[])
                    .await;
                let _ = transaction
                    .execute("release savepoint tunnel_slot_exists_runtime", &[])
                    .await;
                let code = error.as_db_error().map(|db_error| db_error.code());
                if !matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                    warn!(
                        org_id = %org_id,
                        runtime_id = %runtime_id,
                        error = ?error,
                        "tunnel runtime usage check failed; continuing without enforcing slot existence"
                    );
                }
                false
            }
        }
    } else {
        false
    };
    entitlement.insert(
        "tunnelSlotExists".to_string(),
        JsonValue::Bool(tunnel_slot_exists),
    );

    let _ = transaction
        .execute("savepoint tunnel_active_count", &[])
        .await;
    let active_tunnel_count: i64 = match transaction
        .query_one(
            "select count(distinct coalesce(runtime_lease_id::text, tunnel_id))::bigint as active_count
             from runtime_tunnel_grants
             where project_id in (select id from projects where org_id = $1)
               and provider = 'self_hosted'
               and expires_at > now()
               and status in ('issuing','active','revoking')",
            &[&org_id],
        )
        .await
    {
        Ok(row) => {
            let _ = transaction
                .execute("release savepoint tunnel_active_count", &[])
                .await;
            row.get("active_count")
        }
        Err(error) => {
            let _ = transaction
                .execute("rollback to savepoint tunnel_active_count", &[])
                .await;
            let _ = transaction
                .execute("release savepoint tunnel_active_count", &[])
                .await;
            let code = error.as_db_error().map(|db_error| db_error.code());
            if !matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                warn!(
                    org_id = %org_id,
                    error = ?error,
                    "failed to count active tunnels; continuing with activeTunnelCount=0"
                );
            }
            0
        }
    };
    entitlement.insert(
        "activeTunnelCount".to_string(),
        JsonValue::from(active_tunnel_count),
    );

    if !tunnel_slot_exists && active_tunnel_count >= max_active_tunnels {
        return Err((
            StatusCode::PAYMENT_REQUIRED,
            Json(ApiError::new(format!(
                    "Tunnel limit reached for this organization ({active_tunnel_count} active; max {max_active_tunnels}).",
                ))),
        ));
    }

    let burn_via_hook = matches!(*provider, TunnelProvider::SelfHosted)
        && state.config.tunnel_broker_hook_secret.is_some();
    let mut burn_amount = state.config.tunnel_credit_burn_amount.max(0);
    if burn_via_hook {
        burn_amount = 0;
    }
    entitlement.insert("burnAmount".to_string(), JsonValue::from(burn_amount));
    entitlement.insert("burnViaHook".to_string(), JsonValue::Bool(burn_via_hook));

    if burn_amount > 0 {
        let mut ledger_metadata = JsonMap::new();
        ledger_metadata.insert(
            "feature".to_string(),
            JsonValue::String("tunnel.grant".to_string()),
        );
        ledger_metadata.insert(
            "provider".to_string(),
            JsonValue::String(provider.as_str().to_string()),
        );
        if let Some(runtime_id) = runtime_id {
            ledger_metadata.insert("runtimeId".to_string(), json!(runtime_id));
        }
        let mut ledger_metadata_value = JsonValue::Object(ledger_metadata);

        let _ = transaction
            .execute("savepoint tunnel_credit_burn", &[])
            .await;
        match process_credit_burn(
            &transaction,
            project_id,
            &org_id,
            runtime_id,
            burn_amount,
            "tunnel_grant",
            None,
            &mut ledger_metadata_value,
        )
        .await
        {
            Ok(snapshot) => {
                let _ = transaction
                    .execute("release savepoint tunnel_credit_burn", &[])
                    .await;
                entitlement.insert(
                    "balanceAfter".to_string(),
                    JsonValue::from(snapshot.balance),
                );
                entitlement.insert(
                    "creditLimit".to_string(),
                    JsonValue::from(snapshot.credit_limit),
                );
            }
            Err((status, payload)) => {
                let error_message = payload.0.message.clone();
                let _ = transaction
                    .execute("rollback to savepoint tunnel_credit_burn", &[])
                    .await;
                let _ = transaction
                    .execute("release savepoint tunnel_credit_burn", &[])
                    .await;

                if status == StatusCode::PAYMENT_REQUIRED {
                    return Err((status, payload));
                }

                warn!(
                    org_id = %org_id,
                    status = %status.as_u16(),
                    error = %error_message,
                    "tunnel credit burn failed; continuing without burning credits"
                );
                if let Err(report_error) = record_system_bug_report(
                    state,
                    SystemBugReportInput {
                        message: "Tunnel credit burn failed".to_string(),
                        details: Some(error_message.clone()),
                        project_id: Some(*project_id),
                        runtime_id,
                        run_id: None,
                        conversation_id: None,
                        priority: "high".to_string(),
                        labels: vec![
                            "billing".to_string(),
                            "tunnel".to_string(),
                            "monitoring".to_string(),
                        ],
                        metadata: json!({
                            "source": "tunnel.entitlement",
                            "status": status.as_u16(),
                            "orgId": org_id.to_string(),
                        }),
                        logs: json!([
                            {
                                "kind": "tunnel.credit_burn.failed",
                                "status": status.as_u16(),
                                "error": error_message,
                            }
                        ]),
                        fingerprint: Some("tunnel.credit_burn.failed".to_string()),
                        dedupe_window_seconds: Some(15 * 60),
                    },
                )
                .await
                {
                    warn!(%report_error, "failed to record tunnel credit burn issue");
                }
                entitlement.insert("burnSkipped".to_string(), JsonValue::Bool(true));
            }
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize entitlement: {error}")))?;

    Ok(JsonValue::Object(entitlement))
}

fn compose_tunnel_metadata(
    request_metadata: Option<&JsonValue>,
    entitlement: Option<&JsonValue>,
    provider_metadata: Option<&JsonValue>,
) -> Option<JsonValue> {
    let mut root = JsonMap::new();
    if let Some(JsonValue::Object(map)) = request_metadata {
        for (key, value) in map {
            root.insert(key.clone(), value.clone());
        }
    } else if let Some(value) = request_metadata {
        root.insert("requestMetadata".to_string(), value.clone());
    }
    if let Some(value) = entitlement {
        root.insert("entitlement".to_string(), value.clone());
    }
    if let Some(JsonValue::Object(map)) = provider_metadata {
        for (key, value) in map {
            if key == ACTIVE_JOB_TUNNEL_METADATA_KEY {
                continue;
            }
            root.insert(key.clone(), value.clone());
        }
    } else if let Some(value) = provider_metadata {
        root.insert("providerMetadata".to_string(), value.clone());
    }
    if root.is_empty() {
        None
    } else {
        Some(JsonValue::Object(root))
    }
}

async fn ensure_project_authorized(
    state: &AppState,
    project_id: &Uuid,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start project check: {error}")))?;
    let project = load_project_record(&transaction, project_id).await?;
    ensure_project_access(&transaction, &project, context, None).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize project check: {error}")))?;
    Ok(())
}

async fn ensure_project_write_authorized(
    state: &AppState,
    project_id: &Uuid,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start project check: {error}")))?;
    let project = load_project_record(&transaction, project_id).await?;
    ensure_project_write_access(&transaction, &project, context, None).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize project check: {error}")))?;
    Ok(())
}

fn parse_required_uuid(value: &str, field: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(bad_request(format!("{field} is required")));
    }
    Uuid::from_str(trimmed).map_err(|_| bad_request(format!("{field} must be a valid UUID")))
}

fn authorize_hook(
    headers: &HeaderMap,
    secret: Option<&String>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(secret) = secret else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("tunnel broker hook secret not configured")),
        ));
    };

    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let expected = format!("Bearer {secret}");
    if auth_header == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(unauthorized("invalid tunnel broker hook token"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn tunnel_usage_bucket_increments_per_interval() {
        let started_at = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let interval = 600;

        assert_eq!(tunnel_usage_bucket(started_at, started_at, interval), 0);
        assert_eq!(
            tunnel_usage_bucket(
                started_at + ChronoDuration::seconds(599),
                started_at,
                interval
            ),
            0
        );
        assert_eq!(
            tunnel_usage_bucket(
                started_at + ChronoDuration::seconds(600),
                started_at,
                interval
            ),
            1
        );
        assert_eq!(
            tunnel_usage_bucket(
                started_at + ChronoDuration::seconds(1201),
                started_at,
                interval
            ),
            2
        );
        assert_eq!(
            tunnel_usage_bucket(
                started_at - ChronoDuration::seconds(5),
                started_at,
                interval
            ),
            0
        );
    }

    #[test]
    fn tunnel_billing_idempotency_key_formats() {
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let bucket = 7;
        let key = tunnel_billing_idempotency_key(runtime_id, lease_id, None, bucket);
        assert!(key.contains(&runtime_id.to_string()));
        assert!(key.contains(&lease_id.to_string()));
        assert!(key.ends_with(&format!(":{bucket}")));

        let key_with_purpose =
            tunnel_billing_idempotency_key(runtime_id, lease_id, Some("preview"), bucket);
        assert!(key_with_purpose.contains("preview"));
    }

    #[test]
    fn normalize_tunnel_purpose_sanitizes_and_truncates() {
        assert_eq!(
            normalize_tunnel_purpose("  Preview  "),
            Some("preview".to_string())
        );
        assert_eq!(
            normalize_tunnel_purpose("weird:purpose!"),
            Some("weird_purpose_".trim_matches('_').to_string())
        );
        assert_eq!(normalize_tunnel_purpose("   "), None);
    }

    #[test]
    fn project_tunnel_idempotency_key_uses_purpose_when_present() {
        let project_id = Uuid::new_v4();
        let interval_seconds = 600;
        let purpose = "Web Preview";

        let key = generate_idempotency_key(project_id, None, None, Some(purpose), interval_seconds);
        assert_eq!(
            key,
            format!(
                "project_tunnel:{}:{}",
                project_id,
                normalize_tunnel_purpose(purpose).expect("normalized purpose")
            )
        );

        let key_again =
            generate_idempotency_key(project_id, None, None, Some(purpose), interval_seconds);
        assert_eq!(key_again, key);
    }

    #[test]
    fn project_tunnel_idempotency_key_falls_back_to_random_uuid() {
        let project_id = Uuid::new_v4();
        let interval_seconds = 600;

        let key = generate_idempotency_key(project_id, None, None, None, interval_seconds);
        let parts: Vec<&str> = key.split(':').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "project_tunnel");
        assert_eq!(parts[1], project_id.to_string());
        assert!(
            Uuid::parse_str(parts[2]).is_ok(),
            "expected uuid suffix, got {key}"
        );
    }

    #[test]
    fn scoped_tunnel_runtime_match_requires_an_exact_bound_runtime() {
        let runtime_id = Uuid::new_v4();

        assert!(ensure_scoped_tunnel_runtime_match(
            Some(runtime_id.to_string().as_str()),
            Some(runtime_id),
        )
        .is_ok());

        for result in [
            ensure_scoped_tunnel_runtime_match(None, Some(runtime_id)),
            ensure_scoped_tunnel_runtime_match(Some("not-a-uuid"), Some(runtime_id)),
            ensure_scoped_tunnel_runtime_match(
                Some(Uuid::new_v4().to_string().as_str()),
                Some(runtime_id),
            ),
            ensure_scoped_tunnel_runtime_match(Some(runtime_id.to_string().as_str()), None),
        ] {
            assert_eq!(
                result.expect_err("runtime binding must fail").0,
                StatusCode::UNAUTHORIZED
            );
        }
    }

    #[test]
    fn runtime_machine_tunnel_accepts_only_the_current_live_generation() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let current = RuntimeTunnelGenerationState {
            private_self_hosted: false,
            status: "running",
            active_lease_id: Some(lease_id),
            lease_project_id: Some(project_id),
            lease_runtime_id: Some(runtime_id),
            lease_status: Some("active"),
            lease_released: false,
        };

        ensure_runtime_tunnel_generation_is_live(&project_id, &runtime_id, Some(lease_id), current)
            .expect("current live runtime generation should be accepted");

        let stale_error = ensure_runtime_tunnel_generation_is_live(
            &project_id,
            &runtime_id,
            Some(Uuid::new_v4()),
            current,
        )
        .expect_err("stale runtime generation must be denied");
        assert_eq!(stale_error.0, StatusCode::UNAUTHORIZED);

        let missing_error =
            ensure_runtime_tunnel_generation_is_live(&project_id, &runtime_id, None, current)
                .expect_err("lease-less token must not authorize a hosted generation");
        assert_eq!(missing_error.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn runtime_machine_tunnel_denies_stopped_or_released_generations() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let stopped = RuntimeTunnelGenerationState {
            private_self_hosted: false,
            status: "stopped",
            active_lease_id: Some(lease_id),
            lease_project_id: Some(project_id),
            lease_runtime_id: Some(runtime_id),
            lease_status: Some("active"),
            lease_released: false,
        };
        let stopped_error = ensure_runtime_tunnel_generation_is_live(
            &project_id,
            &runtime_id,
            Some(lease_id),
            stopped,
        )
        .expect_err("stopped runtime must be denied");
        assert_eq!(stopped_error.0, StatusCode::FORBIDDEN);

        let released = RuntimeTunnelGenerationState {
            status: "running",
            lease_status: Some("released"),
            lease_released: true,
            ..stopped
        };
        let released_error = ensure_runtime_tunnel_generation_is_live(
            &project_id,
            &runtime_id,
            Some(lease_id),
            released,
        )
        .expect_err("released runtime generation must be denied");
        assert_eq!(released_error.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn self_hosted_runtime_machine_tunnel_requires_a_live_runtime_record() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let live = RuntimeTunnelGenerationState {
            private_self_hosted: true,
            status: "ready",
            active_lease_id: None,
            lease_project_id: None,
            lease_runtime_id: None,
            lease_status: None,
            lease_released: false,
        };
        ensure_runtime_tunnel_generation_is_live(&project_id, &runtime_id, None, live)
            .expect("live self-hosted runtime should be accepted");

        let stopped = RuntimeTunnelGenerationState {
            status: "stopped",
            ..live
        };
        let error =
            ensure_runtime_tunnel_generation_is_live(&project_id, &runtime_id, None, stopped)
                .expect_err("stopped self-hosted runtime must be denied");
        assert_eq!(error.0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn self_hosted_successor_generation_is_the_only_token_with_tunnel_authority() {
        let generation = Uuid::new_v4();
        let capabilities = json!({
            "agent": true,
            "_instafyRuntimeTokenGeneration": generation.to_string(),
        });
        let claims = |runtime_generation: Uuid| runtime_contracts::AccessTokenClaims {
            aud: "runtime".to_string(),
            sub: "runtime.service".to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: None,
            runtime_id: Some(Uuid::new_v4().to_string()),
            protocol: None,
            scopes: RUNTIME_TOKEN_DEFAULT_SCOPES
                .iter()
                .map(|scope| scope.to_string())
                .collect(),
            lease_id: None,
            runtime_generation: Some(runtime_generation.to_string()),
            run_id: None,
            iat: 1,
            exp: i64::MAX,
            jti: Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        };

        ensure_runtime_generation_matches(&capabilities, &claims(generation))
            .expect("current successor generation should be tunnel-authorized");
        assert!(ensure_runtime_generation_matches(&capabilities, &claims(Uuid::new_v4())).is_err());
    }

    #[test]
    fn runtime_machine_tunnel_target_requires_the_exact_runtime_and_generation() {
        let private_unleased = RuntimeMachineTunnelBinding {
            runtime_id: Uuid::new_v4(),
            runtime_lease_id: None,
        };
        ensure_runtime_machine_tunnel_target(
            &private_unleased,
            Some(private_unleased.runtime_id),
            None,
        )
        .expect("unleased private runtime target should be accepted");
        assert!(ensure_runtime_machine_tunnel_target(
            &private_unleased,
            Some(private_unleased.runtime_id),
            Some(Uuid::new_v4()),
        )
        .is_err());

        let binding = RuntimeMachineTunnelBinding {
            runtime_id: Uuid::new_v4(),
            runtime_lease_id: Some(Uuid::new_v4()),
        };
        ensure_runtime_machine_tunnel_target(
            &binding,
            Some(binding.runtime_id),
            binding.runtime_lease_id,
        )
        .expect("current bound tunnel target should be accepted");

        assert!(ensure_runtime_machine_tunnel_target(
            &binding,
            Some(Uuid::new_v4()),
            binding.runtime_lease_id,
        )
        .is_err());
        assert!(ensure_runtime_machine_tunnel_target(
            &binding,
            Some(binding.runtime_id),
            Some(Uuid::new_v4()),
        )
        .is_err());
    }

    #[test]
    fn active_job_tunnel_semantics_require_an_explicit_cli_local_port_request() {
        let valid = TunnelRequestBody {
            runtime_id: None,
            runtime_lease_id: None,
            purpose: Some("preview".to_string()),
            local_port: Some(4173),
            metadata: Some(json!({
                "source": ACTIVE_JOB_TUNNEL_SOURCE,
                "localPort": 4173,
            })),
        };
        assert!(ensure_active_job_tunnel_request_semantics(&valid).is_ok());

        let missing_purpose = TunnelRequestBody {
            purpose: None,
            ..valid
        };
        assert!(ensure_active_job_tunnel_request_semantics(&missing_purpose).is_err());

        let wrong_source = TunnelRequestBody {
            purpose: Some("preview".to_string()),
            metadata: Some(json!({ "source": "direct-api", "localPort": 4173 })),
            ..missing_purpose
        };
        assert!(ensure_active_job_tunnel_request_semantics(&wrong_source).is_err());
    }

    #[test]
    fn active_job_revoke_requires_the_exact_persisted_job_and_run() {
        let binding = ActiveJobTunnelBinding {
            job_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            runtime_lease_id: Some(Uuid::new_v4()),
        };
        let metadata = json!({
            (ACTIVE_JOB_TUNNEL_METADATA_KEY): {
                "jobId": binding.job_id,
                "runId": binding.run_id,
                "runtimeId": binding.runtime_id,
                "runtimeLeaseId": binding.runtime_lease_id,
            }
        });
        assert!(ensure_active_job_tunnel_ownership(Some(&metadata), &binding).is_ok());
        assert!(ensure_active_job_tunnel_ownership(None, &binding).is_err());

        let sibling_metadata = json!({
            (ACTIVE_JOB_TUNNEL_METADATA_KEY): {
                "jobId": Uuid::new_v4(),
                "runId": binding.run_id,
            }
        });
        assert!(ensure_active_job_tunnel_ownership(Some(&sibling_metadata), &binding).is_err());

        let other_run_metadata = json!({
            (ACTIVE_JOB_TUNNEL_METADATA_KEY): {
                "jobId": binding.job_id,
                "runId": Uuid::new_v4(),
            }
        });
        assert!(ensure_active_job_tunnel_ownership(Some(&other_run_metadata), &binding).is_err());
    }

    #[test]
    fn tunnel_broadcast_data_recursively_removes_credentials() {
        let sanitized = sanitize_tunnel_broadcast_data(json!({
            "tunnelId": "tunnel-safe",
            "token": "top-level-secret",
            "tokenExpiresAt": "2026-07-14T12:00:00Z",
            "credentials": { "token": "credential-secret" },
            "client": {
                "server": "tunnel.example:2333",
                "hostname": "workspace.example",
                "accessToken": "nested-secret"
            },
            "metadata": [{
                "purpose": "preview",
                "authorization": "Bearer nested-secret"
            }]
        }));

        assert_eq!(sanitized["tunnelId"], "tunnel-safe");
        assert_eq!(sanitized["client"]["server"], "tunnel.example:2333");
        assert!(!sanitized.to_string().contains("secret"));
        assert!(sanitized.get("credentials").is_none());
        assert!(sanitized.get("metadata").is_none());
        assert!(sanitized["client"].get("accessToken").is_none());
    }

    #[test]
    fn tunnel_broker_event_kind_cannot_escape_private_runtime_visibility() {
        for kind in [
            "tunnel.connected",
            " tunnel.credit_burn.failed ",
            "tunnel.runtime_status-updated",
        ] {
            assert_eq!(
                validate_tunnel_broker_event_kind(kind).expect("valid tunnel event"),
                kind.trim()
            );
        }

        for kind in [
            "runtime.status_updated",
            "conversation.message",
            "tunnel.",
            "TUNNEL.connected",
            "tunnel.connected\nproject.changed",
        ] {
            assert!(
                validate_tunnel_broker_event_kind(kind).is_err(),
                "unexpectedly accepted {kind:?}"
            );
        }
    }
}
