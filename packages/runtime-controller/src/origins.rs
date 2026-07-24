use std::net::{IpAddr, Ipv4Addr};
use std::str::FromStr;

use anyhow::{anyhow, Context, Result};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Path, Query, Request, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
    routing::{any, get, post},
    Json, Router,
};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use futures_util::{SinkExt, StreamExt};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio::time::Duration as TokioDuration;
use tokio_postgres::{GenericClient, Row, Transaction};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as TungMessage};
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::auth::{authenticate_request, bearer_token, claims_have_scopes, RequestContext};
use crate::config::{
    ensure_service_runtime_user_id_via_supabase, AppConfig, PgPool,
    DEFAULT_SERVICE_RUNTIME_USER_EMAIL,
};
use crate::errors::{
    bad_gateway, bad_request, forbidden, internal_error, not_found, unauthorized, ApiError,
};
use crate::projects::{
    ensure_project_access, ensure_project_scoped_write_access, ensure_project_write_access,
    ensure_scoped_project_match, load_project_record, parse_optional_uuid_param, ProjectRecord,
};
use crate::runtime::{
    RUNTIME_TOKEN_DEFAULT_SCOPES, RUNTIME_TOKEN_GIT_MINT_SCOPE,
    RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE,
};
use crate::state::{publish_controller_event, AppState};
use crate::tokens::{
    decode_scoped_token, mint_scoped_token, mint_scoped_token_expires_no_later_than,
    mint_scoped_token_with_browser_actor, ScopedTokenRequest,
};
use runtime_contracts::AccessTokenClaims;

mod browser_relay_telemetry;

use browser_relay_telemetry::{
    BrowserRelayContext, BrowserRelayDirection, BrowserRelayOutcome, BrowserRelayTelemetry,
    BrowserRelayTransport,
};

const BROWSER_WEBRTC_POLICY_HEADER: &str = "x-instafy-browser-webrtc-policy";
const BROWSER_WEBRTC_ICE_SERVERS_HEADER: &str = "x-instafy-browser-webrtc-ice-servers";
pub(crate) const JOB_WORKSPACE_LEASE_WRITE_SCOPE: &str = "workspace.lease.write";
pub(crate) const JOB_ORIGIN_TOKEN_MINT_SCOPE: &str = "origin.token.mint";
pub(crate) const JOB_GIT_TOKEN_MINT_SCOPE: &str = "git.token.mint.job";
pub(crate) const JOB_TOKEN_SEPARATED_SCOPE: &str = "job.token.workspace-separated";
const LEGACY_JOB_EXECUTE_SCOPE: &str = "prompt.execute";

#[derive(Debug, Eq, PartialEq)]
enum BrowserWebRtcProxyPolicy {
    Unmanaged,
    Disabled,
    Relay(String),
}

fn browser_webrtc_proxy_policy(
    turn: Option<&crate::browser_turn::BrowserTurnRestConfig>,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    now_unix: i64,
) -> std::result::Result<BrowserWebRtcProxyPolicy, &'static str> {
    let Some(turn) = turn else {
        return Ok(BrowserWebRtcProxyPolicy::Unmanaged);
    };
    if !turn.allows_project(project_id) {
        return Ok(BrowserWebRtcProxyPolicy::Disabled);
    }
    let runtime_id = runtime_id.ok_or("managed WebRTC requires a runtime-bound origin token")?;
    Ok(BrowserWebRtcProxyPolicy::Relay(
        turn.mint_ice_servers_json(project_id, runtime_id, now_unix),
    ))
}

async fn authorize_origin_request(
    state: &AppState,
    headers: &HeaderMap,
    project_id: &Uuid,
    required_scopes: &[&str],
) -> Result<AccessTokenClaims, (StatusCode, Json<ApiError>)> {
    if let Some(token) = bearer_token(headers) {
        let claims = decode_scoped_token(&state.config, &token, "origin access token")
            .map_err(|(status, json)| (status, json))?;
        if claims.project_id != project_id.to_string() {
            return Err(unauthorized("token project mismatch"));
        }
        if !claims_have_scopes(&claims, required_scopes) {
            return Err(unauthorized("insufficient origin scopes"));
        }
        if claims.runtime_id.is_none() {
            return Err(unauthorized(
                "origin mutation token is missing its runtime scope",
            ));
        }
        let context = RequestContext {
            user_id: Uuid::parse_str(claims.sub.trim()).ok(),
            is_service_role: false,
            scoped_claims: Some(claims.clone()),
        };
        let capability = required_scopes
            .first()
            .ok_or_else(|| unauthorized("origin capability is required"))?;
        authorize_runtime_capability(state, &context, project_id, capability).await?;
        return Ok(claims);
    }

    Err(unauthorized(
        "origin endpoint requires scoped origin access token",
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OriginClaimBinding {
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
}

fn validate_origin_identity_claims(
    claims: &AccessTokenClaims,
    project_id: &Uuid,
    origin_id: &Uuid,
) -> Result<OriginClaimBinding, (StatusCode, Json<ApiError>)> {
    let claim_project = Uuid::parse_str(claims.project_id.trim())
        .map_err(|_| unauthorized("token project scope invalid"))?;
    if claim_project != *project_id {
        return Err(unauthorized("token project mismatch"));
    }

    let claimed_origin = claims
        .origin_id
        .as_deref()
        .map(str::trim)
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| unauthorized("token origin scope invalid"))?;
    if claimed_origin.is_some_and(|claimed| claimed != *origin_id) {
        return Err(unauthorized("token origin mismatch"));
    }

    let runtime_id = claims
        .runtime_id
        .as_deref()
        .map(str::trim)
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| unauthorized("token runtime scope invalid"))?;
    let lease_id = claims
        .lease_id
        .as_deref()
        .map(str::trim)
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| unauthorized("token lease scope invalid"))?;

    let expected_audience = runtime_id.or(claimed_origin).ok_or_else(|| {
        unauthorized("origin token must be bound to an origin or runtime identity")
    })?;
    let audience = Uuid::parse_str(claims.aud.trim())
        .map_err(|_| unauthorized("token audience scope invalid"))?;
    if audience != expected_audience {
        return Err(unauthorized("token audience mismatch"));
    }

    if let Some(preferred_runtime) = claims.prefer_runtime.as_deref() {
        let preferred_runtime = Uuid::parse_str(preferred_runtime.trim())
            .map_err(|_| unauthorized("token preferred runtime scope invalid"))?;
        if runtime_id != Some(preferred_runtime) {
            return Err(unauthorized("token runtime bindings disagree"));
        }
    }

    Ok(OriginClaimBinding {
        runtime_id,
        lease_id,
    })
}

fn normalize_origin_registration_endpoint(
    raw: &str,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let mut endpoint = reqwest::Url::parse(raw.trim())
        .map_err(|_| bad_request("endpoint must be a valid HTTP(S) URL"))?;
    if endpoint.scheme() != "http" && endpoint.scheme() != "https" {
        return Err(bad_request("endpoint must use http or https"));
    }
    if !endpoint.username().is_empty() || endpoint.password().is_some() {
        return Err(bad_request("endpoint must not include credentials"));
    }
    if endpoint.query().is_some() || endpoint.fragment().is_some() {
        return Err(bad_request("endpoint must not include a query or fragment"));
    }
    // URL serialization adds `/` to an origin-only URL. Keep one canonical
    // representation so tunnel and re-registration comparisons are exact.
    endpoint.set_fragment(None);
    Ok(endpoint.to_string().trim_end_matches('/').to_string())
}

// Retained from the GitHub-import hardening branch. The shipped
// `register_runtime_bound_origin` path performs origin/runtime binding; these
// endpoint-provenance helpers are kept for parity and future reuse but are not
// wired into the shipped registration flow (self-hosted runtimes legitimately
// register without a controller-issued tunnel).
#[allow(dead_code)]
fn endpoint_is_local_development(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("host.docker.internal")
        || host.eq_ignore_ascii_case("rt.test")
        || host.to_ascii_lowercase().ends_with(".rt.test")
        || is_private_or_local_ip_host(host)
}

#[allow(dead_code)]
async fn authorize_origin_registration_binding(
    transaction: &tokio_postgres::Transaction<'_>,
    config: &AppConfig,
    claims: &AccessTokenClaims,
    project_id: &Uuid,
    origin_id: &Uuid,
    mode: OriginMode,
    endpoint: &str,
) -> Result<OriginClaimBinding, (StatusCode, Json<ApiError>)> {
    let binding = validate_origin_identity_claims(claims, project_id, origin_id)?;

    let existing_origin = transaction
        .query_opt(
            "select project_id, endpoint from workspace_origins where id = $1 for update",
            &[origin_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock origin registration: {error}")))?;
    let existing_endpoint = if let Some(row) = existing_origin {
        let existing_project: Uuid = row.get("project_id");
        if existing_project != *project_id {
            return Err(forbidden(
                "Origin ID is already registered to a different project",
            ));
        }
        Some(row.get::<_, String>("endpoint"))
    } else {
        None
    };

    let mut origin_instance_matches = false;
    if let Some(runtime_id) = binding.runtime_id {
        let runtime_exists = transaction
            .query_opt(
                "select id from runtimes where id = $1 and project_id = $2 limit 1",
                &[&runtime_id, project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to validate origin runtime binding: {error}"
                ))
            })?
            .is_some();
        if !runtime_exists {
            return Err(unauthorized("token runtime does not belong to project"));
        }

        if let Some(lease_id) = binding.lease_id {
            let lease_matches = transaction
                .query_opt(
                    "select id
                     from runtime_leases
                     where id = $1 and project_id = $2 and runtime_id = $3
                       and status in ('pending', 'launching', 'active')
                     limit 1",
                    &[&lease_id, project_id, &runtime_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to validate origin lease binding: {error}"))
                })?
                .is_some();
            if !lease_matches {
                return Err(unauthorized("token lease does not match runtime"));
            }
        }

        let expected_instance = transaction
            .query_opt(
                "select id, origin_id
                 from origin_instances
                 where project_id = $1 and runtime_id = $2 and status <> 'released'
                   and ($3::uuid is null or lease_id = $3)
                 order by updated_at desc
                 limit 1
                 for update",
                &[project_id, &runtime_id, &binding.lease_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to validate origin instance binding: {error}"
                ))
            })?;
        if let Some(row) = expected_instance {
            // Desktop/CLI runtimes may receive an assignment before they have
            // chosen their origin UUID. Once `origin_id` is populated it is
            // immutable for this active runtime/lease; the caller keeps this
            // row lock until the first claim is persisted below.
            let assigned_origin: Option<Uuid> = row.get("origin_id");
            if assigned_origin.is_some_and(|assigned| assigned != *origin_id) {
                return Err(unauthorized("origin does not match runtime assignment"));
            }
            origin_instance_matches = true;
        }
    }

    let existing_endpoint_matches = existing_endpoint
        .as_deref()
        .and_then(|value| normalize_origin_registration_endpoint(value).ok())
        .is_some_and(|value| value == endpoint);
    let hosted_endpoint_matches = mode == OriginMode::Hosted
        && config
            .hosted_origin_endpoint
            .as_deref()
            .and_then(|value| normalize_origin_registration_endpoint(value).ok())
            .is_some_and(|value| value == endpoint);

    let tunnel_endpoint_matches = if let Some(runtime_id) = binding.runtime_id {
        let rows = transaction
            .query(
                "select url
                 from runtime_tunnel_grants
                 where project_id = $1 and runtime_id = $2
                   and status in ('issuing', 'active') and expires_at > now()
                   and ($3::uuid is null or runtime_lease_id = $3)",
                &[project_id, &runtime_id, &binding.lease_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to validate origin tunnel endpoint: {error}"
                ))
            })?;
        rows.into_iter().any(|row| {
            normalize_origin_registration_endpoint(row.get::<_, String>("url").as_str())
                .is_ok_and(|value| value == endpoint)
        })
    } else {
        false
    };

    if !existing_endpoint_matches
        && !hosted_endpoint_matches
        && !tunnel_endpoint_matches
        && !(config.dev_mode && endpoint_is_local_development(endpoint))
    {
        let identity_detail = if origin_instance_matches {
            "runtime assignment exists but endpoint was not controller-issued"
        } else {
            "endpoint is not associated with a controller-issued tunnel"
        };
        tracing::warn!(
            %project_id,
            %origin_id,
            runtime_id = ?binding.runtime_id,
            lease_id = ?binding.lease_id,
            %endpoint,
            %identity_detail,
            "origin registration endpoint rejected"
        );
        return Err(forbidden(
            "Origin endpoint is not authorized for this runtime",
        ));
    }

    Ok(binding)
}

async fn authorize_registered_origin_identity(
    state: &AppState,
    claims: &AccessTokenClaims,
    project_id: &Uuid,
    origin_id: &Uuid,
    allow_released: bool,
) -> Result<OriginClaimBinding, (StatusCode, Json<ApiError>)> {
    let binding = validate_origin_identity_claims(claims, project_id, origin_id)?;
    if let Some(runtime_id) = binding.runtime_id {
        let connection =
            state.pool.get().await.map_err(|error| {
                internal_error(format!("failed to acquire connection: {error}"))
            })?;
        let matches = connection
            .query_opt(
                "select id
                 from origin_instances
                 where project_id = $1 and runtime_id = $2 and origin_id = $3
                   and (status <> 'released' or $5)
                   and ($4::uuid is null or lease_id = $4)
                 limit 1",
                &[
                    project_id,
                    &runtime_id,
                    origin_id,
                    &binding.lease_id,
                    &allow_released,
                ],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to validate registered origin identity: {error}"
                ))
            })?
            .is_some();
        if !matches {
            return Err(unauthorized("origin is not assigned to token runtime"));
        }
    }
    Ok(binding)
}

#[derive(Debug)]
struct RuntimeCapabilityContext {
    subject: String,
    runtime_id: Uuid,
    lease_id: Option<Uuid>,
}

#[derive(Debug)]
struct JobCapabilityContext {
    job_id: Uuid,
    subject_user: Uuid,
    runtime_id: Uuid,
    runtime_lease_id: Option<Uuid>,
    run_id: Uuid,
}

#[derive(Debug)]
pub(crate) struct WorkspaceOriginGitContext {
    subject_user: Uuid,
    runtime_id: Option<Uuid>,
    lease_id: Uuid,
    run_id: Option<Uuid>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug)]
struct ScopedGitMintContext {
    subject: String,
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    run_id: Option<Uuid>,
    latest_expires_at: Option<DateTime<Utc>>,
}

fn runtime_token_has_capability(claims: &AccessTokenClaims, capability: &str) -> bool {
    claims.scopes.iter().any(|scope| scope == capability)
        // Tokens minted before the dedicated machine capabilities shipped
        // carried the complete compatibility baseline. Keep those live
        // runtimes working until their short-lived tokens rotate.
        || claims_have_scopes(claims, RUNTIME_TOKEN_DEFAULT_SCOPES)
}

fn git_scopes_are_read_only(scopes: &[String]) -> bool {
    !scopes.is_empty() && scopes.iter().all(|scope| scope == "git.read")
}

fn runtime_capability_state_is_live(
    status: &str,
    active_lease_id: Option<Uuid>,
    lease_status: Option<&str>,
    lease_released_at: Option<DateTime<Utc>>,
) -> bool {
    let live = matches!(status, "ready" | "running" | "draining");
    let active_generation = active_lease_id.is_none()
        || (lease_status == Some("active") && lease_released_at.is_none());
    live && active_generation
}

async fn authorize_runtime_capability(
    state: &AppState,
    context: &RequestContext,
    project_id: &Uuid,
    capability: &str,
) -> Result<RuntimeCapabilityContext, (StatusCode, Json<ApiError>)> {
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("runtime capability token required"))?;
    ensure_scoped_project_match(context, project_id)?;
    if !runtime_token_has_capability(claims, capability) {
        return Err(forbidden(
            "runtime token is missing the required capability",
        ));
    }

    let runtime_id = claims
        .runtime_id
        .as_deref()
        .ok_or_else(|| unauthorized("runtime token is missing its runtime scope"))
        .and_then(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("runtime token scope is invalid"))
        })?;
    let lease_id = claims
        .lease_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("runtime token lease scope is invalid"))
        })
        .transpose()?;
    if claims.aud != project_id.to_string() && claims.aud != runtime_id.to_string() {
        return Err(unauthorized("runtime token audience mismatch"));
    }

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to validate runtime: {error}")))?;
    let row = connection
        .query_opt(
            "select r.provider, r.status, r.capabilities, r.active_lease_id,
                    rl.project_id as lease_project_id, rl.runtime_id as lease_runtime_id,
                    rl.status as lease_status, rl.released_at as lease_released_at
             from runtimes r
             left join runtime_leases rl on rl.id = r.active_lease_id
             where r.id = $1 and r.project_id = $2",
            &[&runtime_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to validate runtime scope: {error}")))?;
    let Some(row) = row else {
        return Err(unauthorized(
            "runtime token is not registered for this project",
        ));
    };

    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let active_lease_id: Option<Uuid> = row.get("active_lease_id");
    let capabilities: JsonValue = row.get("capabilities");
    if crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities) {
        crate::runtime::ensure_runtime_generation_matches(&capabilities, claims)?;
        let token_owner = Uuid::parse_str(claims.sub.trim()).ok();
        if crate::runtime::self_hosted_owner_user_id(&capabilities) != token_owner {
            return Err(unauthorized(
                "runtime token does not belong to the self-hosted runtime owner",
            ));
        }
    }
    if lease_id != active_lease_id {
        return Err(unauthorized(
            "runtime token lease scope is no longer active",
        ));
    }

    let provider_managed =
        !crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities);
    if provider_managed && active_lease_id.is_none() {
        return Err(unauthorized(
            "provider-managed runtime is missing its lease scope",
        ));
    }

    let lease_project_id: Option<Uuid> = row.get("lease_project_id");
    let lease_runtime_id: Option<Uuid> = row.get("lease_runtime_id");
    let lease_status: Option<String> = row.get("lease_status");
    let lease_released_at: Option<DateTime<Utc>> = row.get("lease_released_at");
    if active_lease_id.is_some()
        && (lease_project_id != Some(*project_id)
            || lease_runtime_id != Some(runtime_id)
            || lease_released_at.is_some())
    {
        return Err(unauthorized(
            "runtime token lease scope is no longer active",
        ));
    }
    // Runtime machine capabilities are live-operation credentials. A runtime
    // in cleanup_pending is quarantined and must not mint new Git credentials
    // or read workspace leases while teardown is in progress.
    if !runtime_capability_state_is_live(
        &status,
        active_lease_id,
        lease_status.as_deref(),
        lease_released_at,
    ) {
        return Err(forbidden("runtime is not active"));
    }

    Ok(RuntimeCapabilityContext {
        subject: claims.sub.clone(),
        runtime_id,
        lease_id,
    })
}

pub(crate) async fn authorize_workspace_origin_git_write(
    state: &AppState,
    context: &RequestContext,
    project_id: &Uuid,
) -> Result<WorkspaceOriginGitContext, (StatusCode, Json<ApiError>)> {
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("origin workspace token required"))?;
    ensure_scoped_project_match(context, project_id)?;
    if !claims.scopes.iter().any(|scope| scope == "fs.write")
        || claims.origin_id.as_deref().is_none_or(str::is_empty)
        || !matches!(claims.protocol.as_deref(), Some("http" | "webdav"))
    {
        return Err(forbidden(
            "origin token is missing its workspace-write capability",
        ));
    }

    let subject_user = Uuid::parse_str(claims.sub.trim())
        .map_err(|_| unauthorized("origin token subject is invalid"))?;
    let lease_id = claims
        .lease_id
        .as_deref()
        .ok_or_else(|| unauthorized("origin token is missing its workspace lease"))
        .and_then(|value| {
            Uuid::parse_str(value)
                .map_err(|_| unauthorized("origin token workspace lease is invalid"))
        })?;
    let runtime_id = claims
        .runtime_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("origin token runtime is invalid"))
        })
        .transpose()?;
    let run_id = claims
        .run_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("origin token run is invalid"))
        })
        .transpose()?;
    let runtime_generation = claims
        .runtime_generation
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value)
                .map_err(|_| unauthorized("origin token runtime generation is invalid"))
        })
        .transpose()?;

    let mut connection = state.pool.get().await.map_err(|error| {
        internal_error(format!(
            "failed to validate origin workspace lease: {error}"
        ))
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to validate origin workspace lease: {error}"
        ))
    })?;
    let row = transaction
        .query_opt(
            "select user_id, runtime_id, expires_at
             from workspace_leases
             where id = $1
               and project_id = $2
               and status = 'active'
               and expires_at > now()",
            &[&lease_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate origin workspace lease: {error}"
            ))
        })?
        .ok_or_else(|| unauthorized("origin token workspace lease is no longer active"))?;
    if row.get::<_, Option<Uuid>>("user_id") != Some(subject_user) {
        return Err(unauthorized(
            "origin token subject does not hold the workspace lease",
        ));
    }
    let lease_runtime_id = row.get::<_, Option<Uuid>>("runtime_id");
    if runtime_id.is_some() && lease_runtime_id != runtime_id {
        return Err(unauthorized(
            "origin token runtime does not hold the workspace lease",
        ));
    }
    if let Some(runtime_id) = runtime_id.or(lease_runtime_id) {
        let runtime = transaction
            .query_opt(
                "select provider, capabilities
                 from runtimes
                 where id = $1 and project_id = $2
                 for share",
                &[&runtime_id, project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to validate origin token runtime generation: {error}"
                ))
            })?
            .ok_or_else(|| unauthorized("origin token runtime is no longer registered"))?;
        let provider: String = runtime.get("provider");
        let capabilities: JsonValue = runtime.get("capabilities");
        if crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities) {
            crate::runtime::ensure_bound_runtime_generation_matches(
                &capabilities,
                runtime_generation,
            )?;
            if crate::runtime::self_hosted_owner_user_id(&capabilities) != Some(subject_user) {
                return Err(unauthorized(
                    "origin token subject does not own the private self-hosted runtime",
                ));
            }
        }
    }

    let project = load_project_record(&transaction, project_id).await?;
    let subject_context = RequestContext {
        user_id: Some(subject_user),
        is_service_role: state.config.service_runtime_user_id == Some(subject_user),
        scoped_claims: None,
    };
    ensure_project_write_access(&transaction, &project, &subject_context, None).await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize origin workspace lease validation: {error}"
        ))
    })?;

    Ok(WorkspaceOriginGitContext {
        subject_user,
        runtime_id,
        lease_id,
        run_id,
        expires_at: row.get("expires_at"),
    })
}

async fn authorize_active_job_capability(
    state: &AppState,
    context: &RequestContext,
    project_id: &Uuid,
    capability: &str,
) -> Result<JobCapabilityContext, (StatusCode, Json<ApiError>)> {
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("job capability token required"))?;
    ensure_scoped_project_match(context, project_id)?;
    let has_capability = claims.scopes.iter().any(|scope| scope == capability);
    let legacy_prompt_token = claims
        .scopes
        .iter()
        .any(|scope| scope == LEGACY_JOB_EXECUTE_SCOPE)
        && !claims
            .scopes
            .iter()
            .any(|scope| scope == JOB_TOKEN_SEPARATED_SCOPE);
    let using_legacy_prompt_fallback = !has_capability && legacy_prompt_token;
    if !has_capability && !legacy_prompt_token {
        return Err(forbidden("job token is missing the required capability"));
    }

    let subject_user = Uuid::parse_str(claims.sub.trim())
        .map_err(|_| unauthorized("job token subject is invalid"))?;
    let runtime_id = claims
        .runtime_id
        .as_deref()
        .ok_or_else(|| unauthorized("job token is missing its runtime scope"))
        .and_then(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("job token runtime scope is invalid"))
        })?;
    let run_id = claims
        .run_id
        .as_deref()
        .ok_or_else(|| unauthorized("job token is missing its run scope"))
        .and_then(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("job token run scope is invalid"))
        })?;
    let token_runtime_generation = claims
        .runtime_generation
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value)
                .map_err(|_| unauthorized("job token runtime generation scope is invalid"))
        })
        .transpose()?;
    if claims.aud != runtime_id.to_string() {
        return Err(unauthorized("job token audience mismatch"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to validate active job: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to validate active job: {error}")))?;
    let job = transaction
        .query_opt(
            "select j.id, j.payload, j.plan_group_id, r.provider, r.capabilities,
                    r.active_lease_id,
                    rl.project_id as runtime_lease_project_id,
                    rl.runtime_id as runtime_lease_runtime_id,
                    rl.status as runtime_lease_status,
                    rl.released_at as runtime_lease_released_at
             from agent_jobs j
             join runtimes r on r.id = j.leased_by_runtime_id and r.project_id = j.project_id
             left join runtime_leases rl on rl.id = r.active_lease_id
             where j.project_id = $1
               and j.run_id = $2
               and j.leased_by_runtime_id = $3
               and j.status = 'leased'
               and j.lease_expires_at > now()
               and r.status in ('ready', 'running', 'draining')
             order by j.leased_at desc nulls last
             limit 1",
            &[project_id, &run_id, &runtime_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to validate active job: {error}")))?;
    let Some(job) = job else {
        return Err(unauthorized("job token is no longer active"));
    };
    let provider: String = job.get("provider");
    let capabilities: JsonValue = job.get("capabilities");
    let private_self_hosted =
        crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities);
    if private_self_hosted {
        crate::runtime::ensure_bound_runtime_generation_matches(
            &capabilities,
            token_runtime_generation,
        )?;
        if crate::runtime::self_hosted_owner_user_id(&capabilities) != Some(subject_user) {
            return Err(unauthorized(
                "job token subject does not own the private self-hosted runtime",
            ));
        }
    }

    // A token minted by the new controller always carries its runtime lease
    // generation, including the rolling old-runtime compatibility shape.
    // Only genuinely pre-deploy, unmarked prompt tokens may be lease-less;
    // those remain bounded to the exact still-leased job/run/runtime below.
    if has_capability || claims.lease_id.is_some() {
        let token_runtime_lease_id = claims
            .lease_id
            .as_deref()
            .map(|value| {
                Uuid::parse_str(value)
                    .map_err(|_| unauthorized("job token runtime lease scope is invalid"))
            })
            .transpose()?;
        let active_runtime_lease_id: Option<Uuid> = job.get("active_lease_id");
        if token_runtime_lease_id != active_runtime_lease_id {
            return Err(unauthorized(
                "job token runtime lease scope is no longer active",
            ));
        }
        let provider_managed = !private_self_hosted;
        if provider_managed && active_runtime_lease_id.is_none() {
            return Err(unauthorized(
                "provider-managed job token is missing its runtime lease scope",
            ));
        }
        if active_runtime_lease_id.is_some()
            && (job.get::<_, Option<Uuid>>("runtime_lease_project_id") != Some(*project_id)
                || job.get::<_, Option<Uuid>>("runtime_lease_runtime_id") != Some(runtime_id)
                || job
                    .get::<_, Option<DateTime<Utc>>>("runtime_lease_released_at")
                    .is_some()
                || job
                    .get::<_, Option<String>>("runtime_lease_status")
                    .as_deref()
                    != Some("active"))
        {
            return Err(unauthorized(
                "job token runtime lease scope is no longer active",
            ));
        }
    }

    let service_subject = state.config.service_runtime_user_id == Some(subject_user);
    let job_id: Uuid = job.get("id");
    let payload: JsonValue = job.get("payload");
    let payload_user = payload
        .get("user_id")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    if !service_subject && payload_user != Some(subject_user) {
        return Err(unauthorized(
            "job token subject does not match the active job",
        ));
    }
    let plan_group_id: Option<Uuid> = job.get("plan_group_id");
    let allows_workspace_write = job_allows_workspace_mutation(&payload);
    if using_legacy_prompt_fallback
        && matches!(
            capability,
            JOB_WORKSPACE_LEASE_WRITE_SCOPE | JOB_ORIGIN_TOKEN_MINT_SCOPE
        )
        && !legacy_prompt_can_mutate_workspace(&payload, plan_group_id)
    {
        return Err(forbidden(
            "legacy job token is not allowed to mutate this workspace scope",
        ));
    }
    if matches!(
        capability,
        JOB_WORKSPACE_LEASE_WRITE_SCOPE | JOB_ORIGIN_TOKEN_MINT_SCOPE
    ) && !allows_workspace_write
    {
        return Err(forbidden("this job is not allowed to write the workspace"));
    }

    let project = load_project_record(&transaction, project_id).await?;
    let subject_context = RequestContext {
        user_id: Some(subject_user),
        is_service_role: service_subject,
        scoped_claims: None,
    };
    ensure_project_write_access(&transaction, &project, &subject_context, None).await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize active job validation: {error}"))
    })?;

    Ok(JobCapabilityContext {
        job_id,
        subject_user,
        runtime_id,
        runtime_lease_id: job.get("active_lease_id"),
        run_id,
    })
}

fn metadata_uuid(metadata: Option<&JsonValue>, key: &str) -> Option<Uuid> {
    metadata
        .and_then(|value| value.get(key))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

fn job_write_scope_mode(payload: &JsonValue) -> Option<String> {
    let metadata = payload.get("metadata").and_then(JsonValue::as_object)?;
    let scope = metadata
        .get("writeScope")
        .or_else(|| metadata.get("write_scope"))
        .or_else(|| {
            metadata
                .get("agent")
                .and_then(JsonValue::as_object)
                .and_then(|agent| agent.get("writeScope").or_else(|| agent.get("write_scope")))
        })?;
    scope
        .as_object()
        .and_then(|scope| scope.get("mode"))
        .and_then(JsonValue::as_str)
        .or_else(|| scope.as_str())
        .map(|mode| mode.trim().to_ascii_lowercase().replace('-', "_"))
        .filter(|mode| !mode.is_empty())
}

fn job_write_intent(payload: &JsonValue) -> bool {
    payload
        .get("writeIntent")
        .or_else(|| payload.get("write_intent"))
        .or_else(|| {
            payload
                .get("metadata")
                .and_then(JsonValue::as_object)
                .and_then(|metadata| {
                    metadata
                        .get("writeIntent")
                        .or_else(|| metadata.get("write_intent"))
                })
        })
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
}

pub(crate) fn job_allows_workspace_mutation(payload: &JsonValue) -> bool {
    job_write_intent(payload)
        && !matches!(
            job_write_scope_mode(payload).as_deref(),
            Some("read_only" | "readonly" | "coordination_required")
        )
}

fn job_is_generic_single_writer(payload: &JsonValue, plan_group_id: Option<Uuid>) -> bool {
    job_write_intent(payload)
        && plan_group_id.is_none()
        && !matches!(
            job_write_scope_mode(payload).as_deref(),
            Some(
                "read_only"
                    | "readonly"
                    | "coordination_required"
                    | "owned"
                    | "exact"
                    | "path_owned"
                    | "write"
                    | "write_scoped"
            )
        )
}

fn legacy_prompt_can_mutate_workspace(payload: &JsonValue, plan_group_id: Option<Uuid>) -> bool {
    // Before workspace/model credentials were separated, the prompt token was
    // also used by the runtime's post-turn commit path. Retain that rolling
    // compatibility only for the same generic, single-job write shape that is
    // safe to grant raw Git write. Scoped and coordinated jobs must use the
    // explicit separated workspace token issued by the current controller.
    job_is_generic_single_writer(payload, plan_group_id)
}

fn ensure_job_lease_metadata(
    metadata: Option<&JsonValue>,
    job: &JobCapabilityContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if metadata_uuid(metadata, "jobId") != Some(job.job_id)
        || metadata_uuid(metadata, "runId") != Some(job.run_id)
        || metadata_uuid(metadata, "runtimeId") != Some(job.runtime_id)
    {
        return Err(unauthorized(
            "workspace lease metadata does not match the active job",
        ));
    }
    Ok(())
}

fn ensure_workspace_lease_matches_job(
    lease: &WorkspaceLeaseRecord,
    job: &JobCapabilityContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if lease.user_id != Some(job.subject_user)
        || lease.runtime_id != Some(job.runtime_id)
        || lease.status != "active"
        || lease.expires_at <= Utc::now()
    {
        return Err(forbidden(
            "workspace lease does not belong to the active job",
        ));
    }
    ensure_job_lease_metadata(lease.metadata.as_ref(), job)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OriginMode {
    Desktop,
    Efs,
    Hosted,
}

impl OriginMode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            OriginMode::Desktop => "desktop",
            OriginMode::Efs => "efs",
            OriginMode::Hosted => "hosted",
        }
    }
}

impl FromStr for OriginMode {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "desktop" => Ok(OriginMode::Desktop),
            "efs" => Ok(OriginMode::Efs),
            "hosted" => Ok(OriginMode::Hosted),
            other => Err(anyhow!("unsupported origin mode: {other}")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OriginPresenceStatus {
    Online,
    Offline,
    Degraded,
}

impl OriginPresenceStatus {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            OriginPresenceStatus::Online => "online",
            OriginPresenceStatus::Offline => "offline",
            OriginPresenceStatus::Degraded => "degraded",
        }
    }
}

impl FromStr for OriginPresenceStatus {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "online" => Ok(OriginPresenceStatus::Online),
            "offline" => Ok(OriginPresenceStatus::Offline),
            "degraded" => Ok(OriginPresenceStatus::Degraded),
            other => Err(anyhow!("unsupported origin presence status: {other}")),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceOriginRecord {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) mode: OriginMode,
    pub(crate) endpoint: String,
    pub(crate) protocols: Vec<String>,
    pub(crate) region: Option<String>,
    pub(crate) device_id: Option<String>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct OriginPresenceRecord {
    pub(crate) origin_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) status: OriginPresenceStatus,
    pub(crate) last_heartbeat: DateTime<Utc>,
    pub(crate) latency_ms: Option<i32>,
    pub(crate) region: Option<String>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct WorkspaceLeaseRecord {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) user_id: Option<Uuid>,
    pub(crate) runtime_id: Option<Uuid>,
    pub(crate) status: String,
    pub(crate) acquired_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) released_at: Option<DateTime<Utc>>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct CommitReceiptRecord {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) origin_id: Uuid,
    pub(crate) lease_id: Option<Uuid>,
    pub(crate) user_id: Option<Uuid>,
    pub(crate) rev: String,
    pub(crate) bytes_written: Option<i64>,
    pub(crate) file_count: Option<i32>,
    pub(crate) duration_ms: Option<i32>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) created_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct OriginAccessGrantRecord {
    pub(crate) id: Uuid,
    pub(crate) jti: Option<Uuid>,
    pub(crate) project_id: Uuid,
    pub(crate) origin_id: Uuid,
    pub(crate) user_id: Option<Uuid>,
    pub(crate) lease_id: Option<Uuid>,
    pub(crate) scopes: Vec<String>,
    pub(crate) token_type: String,
    pub(crate) issued_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) issued_ip: Option<std::net::IpAddr>,
    pub(crate) metadata: Option<JsonValue>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedOrigin {
    pub(crate) origin: WorkspaceOriginRecord,
    pub(crate) presence: Option<OriginPresenceRecord>,
}

fn origin_from_row(row: &Row) -> Result<WorkspaceOriginRecord> {
    Ok(WorkspaceOriginRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        mode: OriginMode::from_str(row.get::<_, String>("mode").as_str())?,
        endpoint: row.get("endpoint"),
        protocols: row.get("protocols"),
        region: row.get("region"),
        device_id: row.get("device_id"),
        metadata: row.get("metadata"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn presence_from_row(row: &Row) -> Result<OriginPresenceRecord> {
    Ok(OriginPresenceRecord {
        origin_id: row.get("origin_id"),
        project_id: row.get("project_id"),
        status: OriginPresenceStatus::from_str(row.get::<_, String>("status").as_str())?,
        last_heartbeat: row.get("last_heartbeat"),
        latency_ms: row.get("latency_ms"),
        region: row.get("region"),
        metadata: row.get("metadata"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

const ORIGIN_PRESENCE_OFFLINE_THRESHOLD_SECONDS: i64 = 25;

pub(crate) fn spawn_origin_presence_housekeeping(state: &AppState) {
    let state_clone = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(TokioDuration::from_secs(10));
        loop {
            ticker.tick().await;
            if let Err(error) = sweep_stale_origin_presence(&state_clone).await {
                warn!(?error, "origin presence sweep failed");
            }
        }
    });
}

async fn sweep_stale_origin_presence(state: &AppState) -> Result<()> {
    let threshold = ORIGIN_PRESENCE_OFFLINE_THRESHOLD_SECONDS.max(5);
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for origin presence sweep")?;
    let rows = connection
        .query(
            "select origin_id, project_id
             from origin_presence
             where status <> 'offline'
               and last_heartbeat < now() - ($1::bigint * interval '1 second')",
            &[&threshold],
        )
        .await
        .context("failed to query stale origin presence")?;
    drop(connection);

    if rows.is_empty() {
        return Ok(());
    }

    for row in rows {
        let origin_id: Uuid = row.get("origin_id");
        let project_id: Uuid = row.get("project_id");
        match mark_presence_offline(&state.pool, &origin_id, &project_id).await {
            Ok(Some(presence)) => match load_origin_by_id(&state.pool, &origin_id).await {
                Ok(Some(origin)) => {
                    publish_controller_event(
                        &state.events,
                        "origin.expired",
                        Some(project_id),
                        None,
                        None,
                        None,
                        origin_event_payload(&origin, Some(&presence)),
                    );
                }
                Ok(None) => {
                    warn!(%origin_id, %project_id, "stale origin presence without registered origin");
                }
                Err(error) => {
                    warn!(%origin_id, %project_id, ?error, "failed to load origin for presence sweep");
                }
            },
            Ok(None) => {
                // Presence already offline or removed; nothing to emit.
            }
            Err(error) => {
                warn!(%origin_id, %project_id, ?error, "failed to mark stale origin offline");
            }
        }
    }

    Ok(())
}

async fn mark_presence_offline(
    pool: &PgPool,
    origin_id: &Uuid,
    project_id: &Uuid,
) -> Result<Option<OriginPresenceRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for mark_presence_offline")?;
    let row = connection
        .query_opt(
            "update origin_presence
             set status = 'offline',
                 updated_at = now()
             where origin_id = $1
               and project_id = $2
               and status <> 'offline'
             returning *",
            &[origin_id, project_id],
        )
        .await
        .context("failed to mark origin presence offline")?;
    match row {
        Some(record) => presence_from_row(&record).map(Some),
        None => Ok(None),
    }
}

fn origin_event_payload(
    origin: &WorkspaceOriginRecord,
    presence: Option<&OriginPresenceRecord>,
) -> JsonValue {
    let mut data = JsonMap::new();
    data.insert("originId".to_string(), json!(origin.id));
    data.insert("projectId".to_string(), json!(origin.project_id));
    data.insert("mode".to_string(), json!(origin.mode.as_str()));
    data.insert("endpoint".to_string(), json!(origin.endpoint));
    data.insert(
        "protocols".to_string(),
        json!(origin
            .protocols
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()),
    );
    data.insert(
        "region".to_string(),
        origin
            .region
            .as_ref()
            .map(|value| json!(value))
            .unwrap_or(JsonValue::Null),
    );
    data.insert(
        "deviceId".to_string(),
        origin
            .device_id
            .as_ref()
            .map(|value| json!(value))
            .unwrap_or(JsonValue::Null),
    );
    data.insert(
        "metadata".to_string(),
        origin.metadata.clone().unwrap_or(JsonValue::Null),
    );

    if let Some(presence) = presence {
        let mut presence_map = JsonMap::new();
        presence_map.insert(
            "status".to_string(),
            json!(presence.status.as_str().to_string()),
        );
        presence_map.insert(
            "lastHeartbeat".to_string(),
            json!(presence.last_heartbeat.to_rfc3339()),
        );
        presence_map.insert(
            "latencyMs".to_string(),
            presence
                .latency_ms
                .map(JsonValue::from)
                .unwrap_or(JsonValue::Null),
        );
        presence_map.insert(
            "region".to_string(),
            presence
                .region
                .as_ref()
                .map(|value| json!(value))
                .unwrap_or(JsonValue::Null),
        );
        presence_map.insert(
            "metadata".to_string(),
            presence.metadata.clone().unwrap_or(JsonValue::Null),
        );
        presence_map.insert(
            "updatedAt".to_string(),
            json!(presence.updated_at.to_rfc3339()),
        );
        data.insert("presence".to_string(), JsonValue::Object(presence_map));
    } else {
        data.insert("presence".to_string(), JsonValue::Null);
    }

    JsonValue::Object(data)
}

#[derive(Debug)]
struct OriginRegistrationInstance {
    id: Uuid,
    origin_id: Option<Uuid>,
    mode: Option<String>,
}

fn expected_runtime_bound_origin_id(
    candidate: Option<&OriginRegistrationInstance>,
    is_private_self_hosted: bool,
    runtime_id: Uuid,
) -> Option<Uuid> {
    match candidate {
        Some(candidate) => Some(candidate.origin_id.unwrap_or(if is_private_self_hosted {
            runtime_id
        } else {
            candidate.id
        })),
        None if is_private_self_hosted => Some(runtime_id),
        None => None,
    }
}

async fn register_runtime_bound_origin(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    origin_id: &Uuid,
    mode: OriginMode,
    endpoint: &str,
    protocols: &[String],
    region: Option<&str>,
    device_id: Option<&str>,
    metadata: Option<&JsonValue>,
    claims: &AccessTokenClaims,
) -> Result<WorkspaceOriginRecord, (StatusCode, Json<ApiError>)> {
    if *origin_id == hosted_origin_id_for_project(project_id) {
        return Err(forbidden(
            "the configured hosted gateway origin id is reserved",
        ));
    }
    let expected_origin_id = origin_id.to_string();
    if claims
        .origin_id
        .as_deref()
        .is_some_and(|claimed| claimed != expected_origin_id.as_str())
    {
        return Err(unauthorized("origin token scope does not match origin"));
    }

    let runtime_id = claims
        .runtime_id
        .as_deref()
        .ok_or_else(|| unauthorized("origin mutation token is missing its runtime scope"))
        .and_then(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("runtime token scope is invalid"))
        })?;
    let token_lease_id = claims
        .lease_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("runtime token lease scope is invalid"))
        })
        .transpose()?;

    let _ = load_project_record(transaction, project_id).await?;
    let runtime = transaction
        .query_opt(
            "select provider, status, capabilities, active_lease_id
             from runtimes
             where id = $1 and project_id = $2
             for update",
            &[&runtime_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to lock origin registration runtime: {error}"
            ))
        })?
        .ok_or_else(|| unauthorized("runtime token is not registered for this project"))?;

    let provider: String = runtime.get("provider");
    let status: String = runtime.get("status");
    let capabilities: JsonValue = runtime.get("capabilities");
    let active_lease_id: Option<Uuid> = runtime.get("active_lease_id");
    let is_private_self_hosted =
        crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities);

    if is_private_self_hosted {
        crate::runtime::ensure_runtime_generation_matches(&capabilities, claims)?;
        let token_owner = Uuid::parse_str(claims.sub.trim()).ok();
        if crate::runtime::self_hosted_owner_user_id(&capabilities) != token_owner {
            return Err(unauthorized(
                "runtime token does not belong to the self-hosted runtime owner",
            ));
        }
    }
    if token_lease_id != active_lease_id {
        return Err(unauthorized(
            "runtime token lease scope is no longer active",
        ));
    }
    if !is_private_self_hosted && active_lease_id.is_none() {
        return Err(unauthorized(
            "provider-managed runtime is missing its lease scope",
        ));
    }

    let (lease_status, lease_released_at) = if let Some(lease_id) = active_lease_id {
        let lease = transaction
            .query_opt(
                "select status, released_at
                 from runtime_leases
                 where id = $1 and project_id = $2 and runtime_id = $3
                 for update",
                &[&lease_id, project_id, &runtime_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to lock origin registration runtime lease: {error}"
                ))
            })?
            .ok_or_else(|| unauthorized("runtime token lease scope is no longer active"))?;
        (
            Some(lease.get::<_, String>("status")),
            lease.get::<_, Option<DateTime<Utc>>>("released_at"),
        )
    } else {
        (None, None)
    };
    if !runtime_capability_state_is_live(
        &status,
        active_lease_id,
        lease_status.as_deref(),
        lease_released_at,
    ) {
        return Err(forbidden("runtime is not active"));
    }

    // Serialize every attempted claim of this public origin identifier. The
    // lock covers both workspace_origins and origin_instances, whose separate
    // uniqueness constraints cannot otherwise make the binding atomic.
    let lock_key = format!("instafy:origin-registration:{origin_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to lock origin registration identity: {error}"
            ))
        })?;

    let candidate = transaction
        .query_opt(
            "select id, origin_id, mode
             from origin_instances
             where project_id = $1
               and runtime_id = $2
               and lease_id is not distinct from $3
               and status <> 'released'
             order by updated_at desc
             limit 1
             for update",
            &[project_id, &runtime_id, &active_lease_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to lock origin registration instance: {error}"
            ))
        })?
        .map(|row| OriginRegistrationInstance {
            id: row.get("id"),
            origin_id: row.get("origin_id"),
            mode: row.get("mode"),
        });

    if candidate.is_none() && !is_private_self_hosted {
        return Err(forbidden(
            "provider-managed runtime is missing its preallocated origin instance",
        ));
    }

    let expected_origin_id =
        expected_runtime_bound_origin_id(candidate.as_ref(), is_private_self_hosted, runtime_id)
            .ok_or_else(|| {
                forbidden("provider-managed runtime is missing its preallocated origin instance")
            })?;
    if expected_origin_id != *origin_id {
        return Err(forbidden(
            "origin id does not match the controller-bound runtime identity",
        ));
    }

    if let Some(candidate) = candidate.as_ref() {
        if let Some(expected_mode) = candidate.mode.as_deref() {
            if expected_mode != mode.as_str() {
                return Err(bad_request(
                    "origin mode does not match the runtime's allocated origin instance",
                ));
            }
        }
    }

    let candidate_id = candidate.as_ref().map(|candidate| candidate.id);
    let conflicting_instance = transaction
        .query_opt(
            "select id
             from origin_instances
             where (id = $1 or origin_id = $1)
               and ($2::uuid is null or id <> $2)
             limit 1
             for update",
            &[origin_id, &candidate_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate origin registration identity: {error}"
            ))
        })?;
    if conflicting_instance.is_some() {
        return Err(forbidden(
            "origin id is already bound to another runtime instance",
        ));
    }

    let existing_origin = transaction
        .query_opt(
            "select project_id
             from workspace_origins
             where id = $1
             for update",
            &[origin_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate existing workspace origin identity: {error}"
            ))
        })?;
    if let Some(existing_origin) = existing_origin {
        let existing_project_id: Uuid = existing_origin.get("project_id");
        if existing_project_id != *project_id {
            return Err(forbidden("origin id belongs to a different project"));
        }
        if candidate.as_ref().and_then(|candidate| candidate.origin_id) != Some(*origin_id) {
            return Err(forbidden(
                "origin id is already registered outside this runtime binding",
            ));
        }
    }

    let origin = upsert_workspace_origin_with_client(
        transaction,
        origin_id,
        project_id,
        mode,
        endpoint,
        protocols,
        region,
        device_id,
        metadata,
    )
    .await
    .map_err(|error| internal_error(format!("failed to register origin: {error}")))?;

    let metadata_json: Option<JsonValue> = metadata.cloned();
    if let Some(candidate) = candidate {
        let updated = transaction
            .execute(
                "update origin_instances
             set origin_id = $2,
                 endpoint = $3,
                 protocols = $4::text[],
                 metadata = coalesce($5, metadata),
                 required = true,
                 status = 'online',
                 updated_at = now()
             where id = $1
               and project_id = $6
               and runtime_id = $7
               and lease_id is not distinct from $8
               and origin_id is not distinct from $9",
                &[
                    &candidate.id,
                    origin_id,
                    &endpoint,
                    &protocols,
                    &metadata_json,
                    project_id,
                    &runtime_id,
                    &active_lease_id,
                    &candidate.origin_id,
                ],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to update origin instance registration: {error}"
                ))
            })?;
        if updated != 1 {
            return Err(forbidden(
                "origin instance changed while registration was in progress",
            ));
        }
    } else {
        let inserted = transaction
            .execute(
                "insert into origin_instances (
                     id, project_id, runtime_id, lease_id, origin_id, required,
                     mode, status, endpoint, protocols, metadata
                 ) values (
                     $1, $2, $3, $4, $1, true,
                     $5, 'online', $6, $7::text[], $8
                 )",
                &[
                    origin_id,
                    project_id,
                    &runtime_id,
                    &active_lease_id,
                    &mode.as_str(),
                    &endpoint,
                    &protocols,
                    &metadata_json,
                ],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to create self-hosted origin instance: {error}"
                ))
            })?;
        if inserted != 1 {
            return Err(forbidden("failed to bind self-hosted origin instance"));
        }
    }

    Ok(origin)
}

fn lease_from_row(row: &Row) -> WorkspaceLeaseRecord {
    WorkspaceLeaseRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        user_id: row.get("user_id"),
        runtime_id: row.get("runtime_id"),
        status: row.get("status"),
        acquired_at: row.get("acquired_at"),
        expires_at: row.get("expires_at"),
        released_at: row.get("released_at"),
        metadata: row.get("metadata"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn commit_receipt_from_row(row: &Row) -> CommitReceiptRecord {
    CommitReceiptRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        origin_id: row.get("origin_id"),
        lease_id: row.get("lease_id"),
        user_id: row.get("user_id"),
        rev: row.get("rev"),
        bytes_written: row.get("bytes_written"),
        file_count: row.get("file_count"),
        duration_ms: row.get("duration_ms"),
        metadata: row.get("metadata"),
        created_at: row.get("created_at"),
    }
}

fn access_grant_from_row(row: &Row) -> OriginAccessGrantRecord {
    OriginAccessGrantRecord {
        id: row.get("id"),
        jti: row.get("jti"),
        project_id: row.get("project_id"),
        origin_id: row.get("origin_id"),
        user_id: row.get("user_id"),
        lease_id: row.get("lease_id"),
        scopes: row.get("scopes"),
        token_type: row.get("token_type"),
        issued_at: row.get("issued_at"),
        expires_at: row.get("expires_at"),
        issued_ip: row.get("issued_ip"),
        metadata: row.get("metadata"),
    }
}

#[instrument(skip(pool))]
pub(crate) async fn load_origin_by_id(
    pool: &PgPool,
    origin_id: &Uuid,
) -> Result<Option<WorkspaceOriginRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for load_origin_by_id")?;

    let row = connection
        .query_opt(
            "select *
             from workspace_origins
             where id = $1",
            &[origin_id],
        )
        .await
        .context("failed to load workspace origin by id")?;

    match row {
        Some(record) => origin_from_row(&record).map(Some),
        None => Ok(None),
    }
}

async fn ensure_origin_mutation_binding(
    pool: &PgPool,
    claims: &AccessTokenClaims,
    project_id: &Uuid,
    origin_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let expected_origin_id = origin_id.to_string();
    if claims
        .origin_id
        .as_deref()
        .is_some_and(|claimed| claimed != expected_origin_id.as_str())
    {
        return Err(unauthorized("origin token scope does not match origin"));
    }
    let runtime_id = claims
        .runtime_id
        .as_deref()
        .ok_or_else(|| unauthorized("origin mutation token is missing its runtime scope"))
        .and_then(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("runtime token scope is invalid"))
        })?;
    let lease_id = claims
        .lease_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| unauthorized("runtime token lease scope is invalid"))
        })
        .transpose()?;
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to validate origin binding: {error}")))?;
    let bound = connection
        .query_opt(
            "select 1
             from origin_instances
             where project_id = $1
               and runtime_id = $2
               and lease_id is not distinct from $3
               and origin_id = $4
               and status <> 'released'
             limit 1",
            &[project_id, &runtime_id, &lease_id, origin_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to validate origin binding: {error}")))?;
    if bound.is_none() {
        return Err(forbidden("origin is not bound to this runtime generation"));
    }
    Ok(())
}

#[instrument(skip(pool))]
pub(crate) async fn resolve_origin_for_runtime_protocol(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
    protocol: &str,
) -> Result<Option<ResolvedOrigin>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for resolve_origin_for_runtime_protocol")?;

    let rows = connection
        .query(
            "select o.*, oi.protocols as instance_protocols,
                    p.status as presence_status, p.last_heartbeat, p.latency_ms,
                    p.region as presence_region, p.metadata as presence_metadata,
                    p.created_at as presence_created_at, p.updated_at as presence_updated_at
             from origin_instances oi
             join workspace_origins o on o.id = oi.origin_id
             left join origin_presence p on p.origin_id = o.id
             where oi.project_id = $1
               and oi.runtime_id = $2
               and o.project_id = oi.project_id
               and oi.status = 'online'
               and oi.origin_id is not null
             order by oi.updated_at desc
             limit 3",
            &[project_id, runtime_id],
        )
        .await
        .context("failed to resolve origin for runtime protocol")?;

    for row in rows.iter() {
        let origin = origin_from_row(row)?;
        let instance_protocols: Option<Vec<String>> = row.get("instance_protocols");
        let supported_protocols = instance_protocols
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| origin.protocols.clone());
        if !supported_protocols.is_empty()
            && !supported_protocols.iter().any(|value| value == protocol)
        {
            continue;
        }

        let presence_status: Option<String> = row.get("presence_status");
        let presence = match presence_status {
            Some(status) => Some(OriginPresenceRecord {
                origin_id: origin.id,
                project_id: origin.project_id,
                status: OriginPresenceStatus::from_str(&status)?,
                last_heartbeat: row.get("last_heartbeat"),
                latency_ms: row.get("latency_ms"),
                region: row.get("presence_region"),
                metadata: row.get("presence_metadata"),
                created_at: row
                    .get::<_, Option<DateTime<Utc>>>("presence_created_at")
                    .unwrap_or(origin.created_at),
                updated_at: row
                    .get::<_, Option<DateTime<Utc>>>("presence_updated_at")
                    .unwrap_or(origin.updated_at),
            }),
            None => None,
        };

        return Ok(Some(ResolvedOrigin { origin, presence }));
    }

    Ok(None)
}

async fn runtime_provider_for_project(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<Option<(String, JsonValue)>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for runtime project validation")?;

    let row = connection
        .query_opt(
            "select provider, capabilities
             from runtimes
             where id = $1
               and project_id = $2",
            &[runtime_id, project_id],
        )
        .await
        .context("failed to validate preferred runtime project")?;

    Ok(row.map(|row| (row.get("provider"), row.get("capabilities"))))
}

#[derive(Clone, Debug)]
struct OriginRuntimeBinding {
    runtime_id: Uuid,
    provider: String,
    capabilities: JsonValue,
}

async fn load_origin_runtime_binding(
    pool: &PgPool,
    origin: &WorkspaceOriginRecord,
    expected_runtime_id: Option<Uuid>,
) -> Result<Option<OriginRuntimeBinding>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for origin runtime validation")?;
    let row = connection
        .query_opt(
            "select oi.runtime_id, r.provider, r.capabilities
             from origin_instances oi
             join runtimes r
               on r.id = oi.runtime_id
              and r.project_id = oi.project_id
             where oi.project_id = $1
               and oi.origin_id = $2
               and oi.runtime_id is not null
               and oi.status = 'online'
               and r.status in ('ready', 'running', 'draining')
               and ($3::uuid is null or oi.runtime_id = $3)
             order by oi.updated_at desc
             limit 1",
            &[&origin.project_id, &origin.id, &expected_runtime_id],
        )
        .await
        .context("failed to validate origin runtime binding")?;

    Ok(row.map(|row| OriginRuntimeBinding {
        runtime_id: row.get("runtime_id"),
        provider: row.get("provider"),
        capabilities: row.get("capabilities"),
    }))
}

fn origin_is_configured_hosted_gateway(state: &AppState, origin: &WorkspaceOriginRecord) -> bool {
    origin.mode == OriginMode::Hosted
        && state
            .config
            .hosted_origin_endpoint
            .as_deref()
            .is_some_and(|endpoint| {
                origin.id == hosted_origin_id_for_project(&origin.project_id)
                    && origin.endpoint.trim_end_matches('/') == endpoint.trim_end_matches('/')
            })
}

async fn origin_runtime_binding_for_subject(
    state: &AppState,
    origin: &WorkspaceOriginRecord,
    expected_runtime_id: Option<Uuid>,
    subject_user_id: Uuid,
    trusted_service: bool,
) -> Result<Option<OriginRuntimeBinding>, (StatusCode, Json<ApiError>)> {
    let binding = load_origin_runtime_binding(&state.pool, origin, expected_runtime_id)
        .await
        .map_err(|error| {
            internal_error(format!("failed to validate origin runtime access: {error}"))
        })?;

    if let Some(binding) = binding {
        crate::runtime::ensure_self_hosted_runtime_access(
            state,
            &binding.provider,
            &binding.capabilities,
            Some(subject_user_id),
            trusted_service,
        )?;
        return Ok(Some(binding));
    }

    if expected_runtime_id.is_some() {
        return Err(forbidden(
            "origin is not bound to the requested active runtime",
        ));
    }
    if trusted_service || origin_is_configured_hosted_gateway(state, origin) {
        return Ok(None);
    }

    Err(forbidden(
        "unbound desktop and runtime origins are not shareable",
    ))
}

async fn origin_is_accessible_to_subject(
    state: &AppState,
    origin: &WorkspaceOriginRecord,
    subject_user_id: Uuid,
    trusted_service: bool,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    match origin_runtime_binding_for_subject(state, origin, None, subject_user_id, trusted_service)
        .await
    {
        Ok(_) => Ok(true),
        Err((StatusCode::FORBIDDEN, _)) => Ok(false),
        Err(error) => Err(error),
    }
}

async fn authorize_origin_proxy_token_runtime(
    state: &AppState,
    origin: &WorkspaceOriginRecord,
    claims: &AccessTokenClaims,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let subject_user_id = Uuid::parse_str(claims.sub.trim())
        .map_err(|_| unauthorized("origin token subject is invalid"))?;
    let token_runtime_id = claims
        .runtime_id
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value.trim())
                .map_err(|_| unauthorized("origin token runtime scope is invalid"))
        })
        .transpose()?;
    let trusted_service = state.config.service_runtime_user_id == Some(subject_user_id);
    let binding = origin_runtime_binding_for_subject(
        state,
        origin,
        token_runtime_id,
        subject_user_id,
        trusted_service,
    )
    .await
    .map_err(|_| unauthorized("origin token runtime is no longer authorized"))?;

    let Some(binding) = binding else {
        if token_runtime_id.is_some() {
            return Err(unauthorized("origin token runtime binding mismatch"));
        }
        return Ok(());
    };
    if token_runtime_id != Some(binding.runtime_id) {
        return Err(unauthorized("origin token runtime binding mismatch"));
    }

    let browser_scoped = claims
        .scopes
        .iter()
        .any(|scope| is_browser_origin_access_scope(scope));
    if browser_scoped
        && (!crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(&binding.provider)
            || crate::runtime::runtime_is_private_self_hosted(
                state,
                &binding.provider,
                &binding.capabilities,
            ))
    {
        return Err(unauthorized(
            "Shared Browser tokens require a managed Instafy Cloud runtime",
        ));
    }

    if crate::runtime::runtime_is_private_self_hosted(
        state,
        &binding.provider,
        &binding.capabilities,
    ) {
        let token_generation = claims
            .runtime_generation
            .as_deref()
            .map(|value| {
                Uuid::parse_str(value.trim())
                    .map_err(|_| unauthorized("origin token runtime generation is invalid"))
            })
            .transpose()?;
        crate::runtime::ensure_bound_runtime_generation_matches(
            &binding.capabilities,
            token_generation,
        )?;
    }

    Ok(())
}

async fn load_workspace_runtime_binding(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<Option<(String, JsonValue)>, (StatusCode, Json<ApiError>)> {
    runtime_provider_for_project(&state.pool, project_id, runtime_id)
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate workspace lease runtime: {error}"
            ))
        })
}

async fn ensure_workspace_runtime_binding_access(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    user_id: Option<Uuid>,
    is_service_role: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let runtime = load_workspace_runtime_binding(state, project_id, runtime_id).await?;
    let Some((provider, capabilities)) = runtime else {
        return Err(forbidden(
            "Workspace lease runtime is not registered for this project",
        ));
    };
    crate::runtime::ensure_self_hosted_runtime_access(
        state,
        &provider,
        &capabilities,
        user_id,
        is_service_role,
    )
}

async fn workspace_runtime_binding_is_visible(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    user_id: Option<Uuid>,
    is_service_role: bool,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let runtime = load_workspace_runtime_binding(state, project_id, runtime_id).await?;
    Ok(runtime.is_some_and(|(provider, capabilities)| {
        crate::runtime::self_hosted_runtime_is_accessible_to_user(
            state,
            &provider,
            &capabilities,
            user_id,
            is_service_role,
        )
    }))
}

#[instrument(skip(pool))]
#[allow(dead_code)]
pub(crate) async fn list_project_origins(
    pool: &PgPool,
    project_id: &Uuid,
) -> Result<Vec<WorkspaceOriginRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for list_project_origins")?;

    let rows = connection
        .query(
            "select *
             from workspace_origins
             where project_id = $1
             order by created_at asc",
            &[project_id],
        )
        .await
        .context("failed to query workspace origins for project")?;

    rows.iter().map(origin_from_row).collect()
}

async fn auth_user_exists(pool: &PgPool, user_id: &Uuid) -> Result<bool> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for auth user lookup by id")?;
    let row = connection
        .query_opt(
            "select id
             from auth.users
             where id = $1
             limit 1",
            &[user_id],
        )
        .await
        .context("failed to query auth.users by id")?;
    Ok(row.is_some())
}

async fn lookup_auth_user_id_by_email(pool: &PgPool, email: &str) -> Result<Option<Uuid>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for auth user lookup by email")?;
    let row = connection
        .query_opt(
            "select id
             from auth.users
             where lower(email) = lower($1)
             limit 1",
            &[&email],
        )
        .await
        .context("failed to query auth.users by email")?;
    Ok(row.map(|record| record.get("id")))
}

async fn resolve_service_role_subject_user(
    state: &AppState,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    if let Some(user_id) = state.config.service_runtime_user_id {
        let exists = auth_user_exists(&state.pool, &user_id)
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to verify configured service runtime user: {error}"
                ))
            })?;
        if exists {
            return Ok(Some(user_id));
        }

        warn!(
            configured_service_runtime_user_id = %user_id,
            "configured service runtime user missing from auth.users; attempting recovery"
        );
    }

    let service_runtime_user_email = std::env::var("SERVICE_RUNTIME_USER_EMAIL")
        .ok()
        .map(|raw| raw.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVICE_RUNTIME_USER_EMAIL.to_string());

    if let Some(user_id) = lookup_auth_user_id_by_email(&state.pool, &service_runtime_user_email)
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to look up service runtime user by email: {error}"
            ))
        })?
    {
        return Ok(Some(user_id));
    }

    let Some(service_role_key) = state.config.supabase_service_role_key.as_ref() else {
        return Ok(None);
    };

    let supabase_project_url = state.config._supabase_project_url.clone();
    let service_role_key = service_role_key.clone();
    let service_runtime_user_email_clone = service_runtime_user_email.clone();
    let service_runtime_user_password = std::env::var("SERVICE_RUNTIME_USER_PASSWORD")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty());

    let ensured = tokio::task::spawn_blocking(move || {
        ensure_service_runtime_user_id_via_supabase(
            &supabase_project_url,
            &service_role_key,
            &service_runtime_user_email_clone,
            service_runtime_user_password.as_deref(),
        )
    })
    .await
    .map_err(|error| {
        internal_error(format!(
            "service runtime user bootstrap task failed: {error}"
        ))
    })?;

    if let Some(user_id) = ensured {
        return Ok(Some(user_id));
    }

    Ok(None)
}

#[instrument(skip(pool))]
pub(crate) async fn resolve_origin_for_protocol(
    pool: &PgPool,
    project_id: &Uuid,
    protocol: &str,
) -> Result<Option<ResolvedOrigin>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for resolve_origin_for_protocol")?;

    let rows = connection
        .query(
            "select o.*, p.status as presence_status, p.last_heartbeat, p.latency_ms,
                    p.region as presence_region, p.metadata as presence_metadata,
                    p.created_at as presence_created_at, p.updated_at as presence_updated_at
             from workspace_origins o
             left join origin_presence p on p.origin_id = o.id
             where o.project_id = $1
               and (cardinality(o.protocols) = 0 or $2 = any(o.protocols))
             order by
               case
                 when p.status is null then 2
                 when p.status = 'online' then 0
                 when p.status = 'degraded' then 1
                 else 3
               end,
               coalesce(p.latency_ms, 1000000),
               coalesce(p.last_heartbeat, o.updated_at) desc
             limit 3",
            &[project_id, &protocol],
        )
        .await
        .context("failed to resolve origin for protocol")?;

    for row in rows.iter() {
        let origin = origin_from_row(row)?;
        let presence_status: Option<String> = row.get("presence_status");
        let presence = match presence_status {
            Some(status) => Some(OriginPresenceRecord {
                origin_id: origin.id,
                project_id: origin.project_id,
                status: OriginPresenceStatus::from_str(&status)?,
                last_heartbeat: row.get("last_heartbeat"),
                latency_ms: row.get("latency_ms"),
                region: row.get("presence_region"),
                metadata: row.get("presence_metadata"),
                created_at: row
                    .get::<_, Option<DateTime<Utc>>>("presence_created_at")
                    .unwrap_or(origin.created_at),
                updated_at: row
                    .get::<_, Option<DateTime<Utc>>>("presence_updated_at")
                    .unwrap_or(origin.updated_at),
            }),
            None => None,
        };

        let is_online = presence
            .as_ref()
            .map(|record| {
                matches!(
                    record.status,
                    OriginPresenceStatus::Online | OriginPresenceStatus::Degraded
                )
            })
            // Hosted origins can be considered always-on even when no presence row is recorded.
            // This supports load-balanced Origin gateways where presence is not tracked per project.
            .unwrap_or(origin.mode == OriginMode::Hosted);
        if !is_online {
            continue;
        }

        return Ok(Some(ResolvedOrigin { origin, presence }));
    }

    Ok(None)
}

fn hosted_origin_id_for_project(project_id: &Uuid) -> Uuid {
    // Stable per-project ID so we can create/update workspace_origins without storing extra state.
    let name = format!("instafy:hosted-origin:{}", project_id);
    Uuid::new_v5(&Uuid::NAMESPACE_URL, name.as_bytes())
}

async fn resolve_hosted_origin_for_protocol(
    state: &AppState,
    project_id: &Uuid,
    protocol: &str,
) -> Result<Option<ResolvedOrigin>> {
    if protocol != "http" {
        return resolve_origin_for_protocol_with_hosted_fallback(state, project_id, protocol).await;
    }

    let Some(endpoint) = state.config.hosted_origin_endpoint.as_deref() else {
        return resolve_origin_for_protocol_with_hosted_fallback(state, project_id, protocol).await;
    };

    let origin_id = hosted_origin_id_for_project(project_id);
    let origin = upsert_workspace_origin(
        &state.pool,
        &origin_id,
        project_id,
        OriginMode::Hosted,
        endpoint,
        &[protocol.to_string()],
        None,
        None,
        None,
    )
    .await?;

    Ok(Some(ResolvedOrigin {
        origin,
        presence: None,
    }))
}

pub(crate) async fn resolve_origin_for_protocol_with_hosted_fallback(
    state: &AppState,
    project_id: &Uuid,
    protocol: &str,
) -> Result<Option<ResolvedOrigin>> {
    let Some(endpoint) = state.config.hosted_origin_endpoint.as_deref() else {
        return resolve_origin_for_protocol(&state.pool, project_id, protocol).await;
    };

    if protocol != "http" {
        // Hosted Origin gateways are HTTP-only for now; WebDAV remains local-canonical.
        return resolve_origin_for_protocol(&state.pool, project_id, protocol).await;
    }

    let origin_id = hosted_origin_id_for_project(project_id);

    // Prefer local-canonical origins (desktop/EFS) when available. If the best candidate is a hosted
    // origin but it's not the stable hosted gateway record, override it with the configured hosted
    // gateway. This avoids ephemeral runtime-registered "hosted" origins stealing traffic.
    if let Some(resolved) = resolve_origin_for_protocol(&state.pool, project_id, protocol).await? {
        if resolved.origin.mode != OriginMode::Hosted {
            return Ok(Some(resolved));
        }
        if resolved.origin.id == origin_id && resolved.origin.endpoint == endpoint {
            return Ok(Some(resolved));
        }
    }

    let origin = upsert_workspace_origin(
        &state.pool,
        &origin_id,
        project_id,
        OriginMode::Hosted,
        endpoint,
        &[protocol.to_string()],
        None,
        None,
        None,
    )
    .await?;

    Ok(Some(ResolvedOrigin {
        origin,
        presence: None,
    }))
}

pub(crate) async fn resolve_accessible_origin_for_protocol_with_hosted_fallback(
    state: &AppState,
    project_id: &Uuid,
    protocol: &str,
    subject_user_id: Uuid,
    trusted_service: bool,
) -> Result<Option<ResolvedOrigin>, (StatusCode, Json<ApiError>)> {
    let resolved = resolve_origin_for_protocol_with_hosted_fallback(state, project_id, protocol)
        .await
        .map_err(|error| internal_error(format!("failed to resolve origin: {error}")))?;

    if let Some(candidate) = resolved {
        if origin_is_accessible_to_subject(
            state,
            &candidate.origin,
            subject_user_id,
            trusted_service,
        )
        .await?
        {
            return Ok(Some(candidate));
        }
    }

    if protocol != "http" || state.config.hosted_origin_endpoint.is_none() {
        return Ok(None);
    }

    let hosted = resolve_hosted_origin_for_protocol(state, project_id, protocol)
        .await
        .map_err(|error| internal_error(format!("failed to resolve hosted origin: {error}")))?;
    let Some(hosted) = hosted else {
        return Ok(None);
    };
    if origin_is_accessible_to_subject(state, &hosted.origin, subject_user_id, trusted_service)
        .await?
    {
        return Ok(Some(hosted));
    }

    Ok(None)
}

#[instrument(skip(pool))]
pub(crate) async fn resolve_desktop_origin_presence(
    pool: &PgPool,
    project_id: &Uuid,
) -> Result<Option<OriginPresenceRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for resolve_desktop_origin_presence")?;

    let rows = connection
        .query(
            "select p.*
             from workspace_origins o
             left join origin_presence p on p.origin_id = o.id
             where o.project_id = $1
               and o.mode = 'desktop'
             order by coalesce(p.updated_at, o.updated_at) desc
             limit 1",
            &[project_id],
        )
        .await
        .context("failed to resolve desktop origin presence")?;

    match rows.first() {
        Some(row) => {
            // If there is no presence row (nulls), p.* will be nulls; guard by checking a not-nullable
            // origin_id field via Option<Uuid> extraction from row.
            let origin_id: Option<Uuid> = row.try_get("origin_id").unwrap_or(None);
            if origin_id.is_none() {
                return Ok(None);
            }
            presence_from_row(row).map(Some)
        }
        None => Ok(None),
    }
}

#[instrument(skip(pool, metadata))]
pub(crate) async fn upsert_workspace_origin(
    pool: &PgPool,
    origin_id: &Uuid,
    project_id: &Uuid,
    mode: OriginMode,
    endpoint: &str,
    protocols: &[String],
    region: Option<&str>,
    device_id: Option<&str>,
    metadata: Option<&JsonValue>,
) -> Result<WorkspaceOriginRecord> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for upsert_workspace_origin")?;

    upsert_workspace_origin_with_client(
        &*connection,
        origin_id,
        project_id,
        mode,
        endpoint,
        protocols,
        region,
        device_id,
        metadata,
    )
    .await
}

async fn upsert_workspace_origin_with_client(
    client: &(impl GenericClient + Sync),
    origin_id: &Uuid,
    project_id: &Uuid,
    mode: OriginMode,
    endpoint: &str,
    protocols: &[String],
    region: Option<&str>,
    device_id: Option<&str>,
    metadata: Option<&JsonValue>,
) -> Result<WorkspaceOriginRecord> {
    let normalized_protocols: Vec<String> = protocols
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect();

    if normalized_protocols.is_empty() {
        return Err(anyhow!("at least one protocol must be provided"));
    }

    let metadata_param = metadata.cloned();
    let region_param = region.map(|value| value.to_string());
    let device_id_param = device_id.map(|value| value.to_string());

    let row = client
        .query_opt(
            "insert into workspace_origins (id, project_id, mode, endpoint, protocols, region, device_id, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             on conflict (id)
             do update set
               mode = excluded.mode,
               endpoint = excluded.endpoint,
               protocols = excluded.protocols,
               region = excluded.region,
               device_id = excluded.device_id,
               metadata = excluded.metadata,
               updated_at = now()
             where workspace_origins.project_id = excluded.project_id
             returning *",
            &[
                origin_id,
                project_id,
                &mode.as_str(),
                &endpoint,
                &normalized_protocols,
                &region_param,
                &device_id_param,
                &metadata_param,
            ],
        )
        .await
        .context("failed to upsert workspace origin")?
        .ok_or_else(|| anyhow!("workspace origin id belongs to another project"))?;

    origin_from_row(&row)
}

#[instrument(skip(pool, metadata))]
pub(crate) async fn record_presence_heartbeat(
    pool: &PgPool,
    origin_id: &Uuid,
    project_id: &Uuid,
    status: OriginPresenceStatus,
    latency_ms: Option<i32>,
    region: Option<&str>,
    metadata: Option<&JsonValue>,
) -> Result<OriginPresenceRecord> {
    let metadata_param = metadata.cloned();

    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for record_presence_heartbeat")?;

    let row = connection
        .query_one(
            "insert into origin_presence (origin_id, project_id, status, last_heartbeat, latency_ms, region, metadata)
             values ($1, $2, $3, now(), $4, $5, $6)
             on conflict (origin_id)
             do update set
               status = excluded.status,
               last_heartbeat = excluded.last_heartbeat,
               latency_ms = excluded.latency_ms,
               region = excluded.region,
               metadata = excluded.metadata,
               updated_at = now()
             returning *",
            &[
                origin_id,
                project_id,
                &status.as_str(),
                &latency_ms,
                &region.map(|value| value.to_string()),
                &metadata_param,
            ],
        )
        .await
        .context("failed to upsert origin presence")?;

    presence_from_row(&row)
}

#[derive(Debug)]
pub(crate) enum LeaseAcquireOutcome {
    Granted(WorkspaceLeaseRecord),
    Renewed(WorkspaceLeaseRecord),
    Conflict { holder: WorkspaceLeaseRecord },
}

const MAX_WORKSPACE_LEASE_SECONDS: i64 = 300;
const MAX_LONG_WORKSPACE_LEASE_SECONDS: i64 = 1_800;
const LEASE_POLICY_METADATA_KEY: &str = "_instafyLeasePolicy";
const ALLOW_IMPLICIT_RENEWAL_METADATA_KEY: &str = "allowImplicitRenewal";

fn fresh_lease_metadata(metadata: Option<&JsonValue>) -> JsonValue {
    let mut metadata = match metadata {
        Some(JsonValue::Object(object)) => JsonValue::Object(object.clone()),
        Some(value) => json!({ "_instafyCallerMetadata": value }),
        None => json!({}),
    };
    metadata
        .as_object_mut()
        .expect("fresh lease metadata object")
        .insert(
            LEASE_POLICY_METADATA_KEY.to_string(),
            json!({ "allowImplicitRenewal": false }),
        );
    metadata
}

fn lease_allows_implicit_renewal(metadata: Option<&JsonValue>) -> bool {
    metadata
        .and_then(|value| value.get(LEASE_POLICY_METADATA_KEY))
        .and_then(|value| value.get(ALLOW_IMPLICIT_RENEWAL_METADATA_KEY))
        .and_then(JsonValue::as_bool)
        .unwrap_or(true)
}

#[instrument(skip(pool, metadata))]
pub(crate) async fn acquire_lease(
    pool: &PgPool,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    requested_seconds: i64,
    metadata: Option<&JsonValue>,
) -> Result<LeaseAcquireOutcome> {
    acquire_lease_with_policy(
        pool,
        project_id,
        user_id,
        runtime_id,
        requested_seconds,
        metadata,
        true,
        MAX_WORKSPACE_LEASE_SECONDS,
    )
    .await
}

/// Acquires a new, non-adoptable lease without renewing an active lease owned
/// by the same user. Long-running one-shot mutations use this so neither this
/// call nor a later ordinary acquisition can adopt or retag another operation's
/// lease before reporting the workspace busy. Exact-id renewal remains valid.
pub(crate) async fn acquire_fresh_lease(
    pool: &PgPool,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    requested_seconds: i64,
    metadata: Option<&JsonValue>,
) -> Result<LeaseAcquireOutcome> {
    let metadata = fresh_lease_metadata(metadata);
    acquire_lease_with_policy(
        pool,
        project_id,
        user_id,
        runtime_id,
        requested_seconds,
        Some(&metadata),
        false,
        MAX_LONG_WORKSPACE_LEASE_SECONDS,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool, metadata))]
async fn acquire_lease_with_policy(
    pool: &PgPool,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    requested_seconds: i64,
    metadata: Option<&JsonValue>,
    renew_same_user: bool,
    max_lease_seconds: i64,
) -> Result<LeaseAcquireOutcome> {
    let lease_seconds = requested_seconds.max(30).min(max_lease_seconds);
    let expires_at = Utc::now() + ChronoDuration::seconds(lease_seconds);
    let metadata_param = metadata.cloned();

    let mut connection = pool
        .get()
        .await
        .context("failed to acquire connection for acquire_lease")?;
    let transaction = connection
        .transaction()
        .await
        .context("failed to start transaction for acquire_lease")?;

    // Lock a row that always exists for the project before checking the
    // partial active-lease set. `SELECT ... FOR UPDATE` on workspace_leases
    // locks nothing when the first lease has not been inserted yet, allowing
    // two devices to both observe an empty set and become writers. The project
    // row serializes that empty-set transition as well as renew/takeover.
    transaction
        .query_one(
            "select id from projects where id = $1 for update",
            &[project_id],
        )
        .await
        .context("failed to lock project for workspace lease acquisition")?;

    let existing_row = transaction
        .query_opt(
            "select *
             from workspace_leases
             where project_id = $1
               and status = 'active'
               and expires_at > now()
             order by expires_at desc
             for update",
            &[project_id],
        )
        .await
        .context("failed to load active workspace lease")?;

    if let Some(row) = existing_row {
        let existing = lease_from_row(&row);

        if renew_same_user
            && user_id.is_some()
            && existing.user_id == user_id.copied()
            && existing.runtime_id == runtime_id.copied()
            && lease_allows_implicit_renewal(existing.metadata.as_ref())
        {
            let updated_row = transaction
                .query_one(
                    "update workspace_leases
                     set expires_at = $1,
                         metadata = coalesce($2, metadata),
                         status = 'active',
                         updated_at = now()
                     where id = $3
                     returning *",
                    &[&expires_at, &metadata_param, &existing.id],
                )
                .await
                .context("failed to renew existing workspace lease")?;

            transaction
                .commit()
                .await
                .context("failed to commit workspace lease renewal")?;

            return Ok(LeaseAcquireOutcome::Renewed(lease_from_row(&updated_row)));
        }

        transaction
            .rollback()
            .await
            .unwrap_or_else(|error| warn!(?error, "failed to rollback conflicting lease txn"));
        return Ok(LeaseAcquireOutcome::Conflict { holder: existing });
    }

    let inserted_row = transaction
        .query_one(
            "insert into workspace_leases (project_id, user_id, runtime_id, status, acquired_at, expires_at, metadata)
             values ($1, $2, $3, 'active', now(), $4, $5)
             returning *",
            &[project_id, &user_id, &runtime_id, &expires_at, &metadata_param],
        )
        .await
        .context("failed to insert new workspace lease")?;

    transaction
        .commit()
        .await
        .context("failed to commit workspace lease acquisition")?;

    Ok(LeaseAcquireOutcome::Granted(lease_from_row(&inserted_row)))
}

#[instrument(skip(pool, metadata))]
pub(crate) async fn renew_lease(
    pool: &PgPool,
    lease_id: &Uuid,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    requested_seconds: i64,
    metadata: Option<&JsonValue>,
) -> Result<Option<WorkspaceLeaseRecord>> {
    renew_lease_with_max(
        pool,
        lease_id,
        project_id,
        user_id,
        runtime_id,
        requested_seconds,
        metadata,
        MAX_WORKSPACE_LEASE_SECONDS,
    )
    .await
}

pub(crate) async fn renew_long_lease(
    pool: &PgPool,
    lease_id: &Uuid,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    requested_seconds: i64,
    metadata: Option<&JsonValue>,
) -> Result<Option<WorkspaceLeaseRecord>> {
    renew_lease_with_max(
        pool,
        lease_id,
        project_id,
        user_id,
        runtime_id,
        requested_seconds,
        metadata,
        MAX_LONG_WORKSPACE_LEASE_SECONDS,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn renew_lease_with_max(
    pool: &PgPool,
    lease_id: &Uuid,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    requested_seconds: i64,
    metadata: Option<&JsonValue>,
    max_lease_seconds: i64,
) -> Result<Option<WorkspaceLeaseRecord>> {
    let lease_seconds = requested_seconds.max(30).min(max_lease_seconds);
    let expires_at = Utc::now() + ChronoDuration::seconds(lease_seconds);
    let metadata_param = metadata.cloned();

    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for renew_lease")?;

    let row = connection
        .query_opt(
            "update workspace_leases
             set expires_at = $1,
                 metadata = case
                   when $2::jsonb is null then metadata
                   when metadata ? '_instafyLeasePolicy' then
                     (case
                       when jsonb_typeof($2::jsonb) = 'object' then $2::jsonb
                       else jsonb_build_object('_instafyCallerMetadata', $2::jsonb)
                     end) || jsonb_build_object(
                       '_instafyLeasePolicy',
                       metadata -> '_instafyLeasePolicy'
                     )
                   else $2::jsonb
                 end,
                 updated_at = now()
             where id = $3
               and project_id = $4
               and status = 'active'
               and (expires_at > now() or expires_at is null)
               and ($5::uuid is null or coalesce(user_id, $5::uuid) = $5)
               and ($6::uuid is null or coalesce(runtime_id, $6::uuid) = $6)
             returning *",
            &[
                &expires_at,
                &metadata_param,
                lease_id,
                project_id,
                &user_id,
                &runtime_id,
            ],
        )
        .await
        .context("failed to renew workspace lease")?;

    Ok(row.map(|record| lease_from_row(&record)))
}

#[instrument(skip(pool))]
pub(crate) async fn load_active_lease_by_id(
    pool: &PgPool,
    lease_id: &Uuid,
) -> Result<Option<WorkspaceLeaseRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for load_active_lease_by_id")?;

    let row = connection
        .query_opt(
            "select *
             from workspace_leases
             where id = $1
               and status = 'active'
               and expires_at > now()",
            &[lease_id],
        )
        .await
        .context("failed to query workspace lease by id")?;

    Ok(row.map(|record| lease_from_row(&record)))
}

/// Narrows a user-held workspace lease to the runtime selected by the
/// controller for an origin write. Origin selection happens after lease
/// acquisition, so a client without a runtime hint can legitimately acquire
/// an unbound lease first. This update is monotonic (NULL -> exact runtime),
/// race-safe, and refuses an already-different binding.
async fn bind_workspace_lease_runtime(
    pool: &PgPool,
    lease_id: &Uuid,
    project_id: &Uuid,
    user_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<Option<WorkspaceLeaseRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for workspace lease runtime binding")?;
    let row = connection
        .query_opt(
            "update workspace_leases
             set runtime_id = coalesce(runtime_id, $4),
                 updated_at = now()
             where id = $1
               and project_id = $2
               and user_id = $3
               and status = 'active'
               and expires_at > now()
               and (runtime_id is null or runtime_id = $4)
             returning *",
            &[lease_id, project_id, user_id, runtime_id],
        )
        .await
        .context("failed to bind workspace lease to origin runtime")?;

    Ok(row.map(|record| lease_from_row(&record)))
}

pub(crate) async fn load_active_lease_for_project(
    pool: &PgPool,
    project_id: &Uuid,
) -> Result<Option<WorkspaceLeaseRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for load_active_lease_for_project")?;

    let row = connection
        .query_opt(
            "select *
             from workspace_leases
             where project_id = $1
               and status = 'active'
               and expires_at > now()
             order by expires_at desc
             limit 1",
            &[project_id],
        )
        .await
        .context("failed to query active workspace lease for project")?;

    Ok(row.map(|record| lease_from_row(&record)))
}

#[instrument(skip(pool))]
pub(crate) async fn release_lease(
    pool: &PgPool,
    lease_id: &Uuid,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
    runtime_id: Option<&Uuid>,
    status: &str,
) -> Result<Option<WorkspaceLeaseRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for release_lease")?;

    let row = connection
        .query_opt(
            "update workspace_leases
             set status = $1,
                 released_at = now(),
                 updated_at = now()
             where id = $2
               and project_id = $3
               and ($4::uuid is null or coalesce(user_id, $4::uuid) = $4)
               and ($5::uuid is null or coalesce(runtime_id, $5::uuid) = $5)
             returning *",
            &[&status, lease_id, project_id, &user_id, &runtime_id],
        )
        .await
        .context("failed to release workspace lease")?;

    Ok(row.map(|record| lease_from_row(&record)))
}

#[instrument(skip(pool))]
#[allow(dead_code)]
pub(crate) async fn expire_stale_leases(pool: &PgPool) -> Result<Vec<WorkspaceLeaseRecord>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for expire_stale_leases")?;

    let rows = connection
        .query(
            "update workspace_leases
             set status = 'expired',
                 released_at = now(),
                 updated_at = now()
             where status = 'active'
               and expires_at <= now()
             returning *",
            &[],
        )
        .await
        .context("failed to expire stale workspace leases")?;

    Ok(rows.into_iter().map(|row| lease_from_row(&row)).collect())
}

#[instrument(skip(pool, metadata))]
pub(crate) async fn record_commit_receipt(
    pool: &PgPool,
    project_id: &Uuid,
    origin_id: &Uuid,
    lease_id: Option<&Uuid>,
    user_id: Option<&Uuid>,
    rev: &str,
    bytes_written: Option<i64>,
    file_count: Option<i32>,
    duration_ms: Option<i32>,
    metadata: Option<&JsonValue>,
) -> Result<CommitReceiptRecord> {
    let metadata_param = metadata.cloned();
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for record_commit_receipt")?;

    let row = connection
        .query_one(
            "insert into workspace_commit_receipts
             (project_id, origin_id, lease_id, user_id, rev, bytes_written, file_count, duration_ms, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning *",
            &[
                project_id,
                origin_id,
                &lease_id,
                &user_id,
                &rev,
                &bytes_written,
                &file_count,
                &duration_ms,
                &metadata_param,
            ],
        )
        .await
        .context("failed to insert workspace commit receipt")?;

    Ok(commit_receipt_from_row(&row))
}

#[instrument(skip(pool, metadata))]
pub(crate) async fn record_access_grant(
    pool: &PgPool,
    project_id: &Uuid,
    origin_id: &Uuid,
    user_id: Option<&Uuid>,
    lease_id: Option<&Uuid>,
    scopes: &[String],
    token_type: &str,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    jti: Option<&Uuid>,
    issued_ip: Option<std::net::IpAddr>,
    metadata: Option<&JsonValue>,
) -> Result<OriginAccessGrantRecord> {
    let metadata_param = metadata.cloned();
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for record_access_grant")?;

    let row = connection
        .query_one(
            "insert into origin_access_grants
             (jti, project_id, origin_id, user_id, lease_id, scopes, token_type, issued_at, expires_at, issued_ip, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             returning *",
            &[
                &jti,
                project_id,
                origin_id,
                &user_id,
                &lease_id,
                &scopes.to_vec(),
                &token_type,
                &issued_at,
                &expires_at,
                &issued_ip,
                &metadata_param,
            ],
        )
        .await
        .context("failed to insert origin access grant")?;

    Ok(access_grant_from_row(&row))
}

/// origin_access_grants records one row per short-lived origin token mint. The
/// rows are never read back (tokens are validated statelessly from their JWT
/// jti/exp claims) and are worthless minutes after issue, yet accumulate
/// forever with no retention — the same unbounded-growth shape that made
/// runtime_events blow the database size quota.
///
/// Deletes grants that expired more than a short audit window ago, in bounded
/// batches. No `expires_at` index leads the composite indexes, so — like the
/// runtime_events prune — we deliberately avoid `order by` and delete by `ctid`
/// so each batch is a cheap bounded scan rather than a full sort.
const ACCESS_GRANT_RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
const ACCESS_GRANT_CLEANUP_BATCH_SIZE: i64 = 5000;
const ACCESS_GRANT_CLEANUP_MAX_BATCHES_PER_RUN: u32 = 20;

#[instrument(skip(pool))]
pub(crate) async fn prune_expired_access_grants(pool: &PgPool) -> Result<u64> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for prune_expired_access_grants")?;

    let mut total_deleted: u64 = 0;
    for _ in 0..ACCESS_GRANT_CLEANUP_MAX_BATCHES_PER_RUN {
        let deleted = connection
            .execute(
                "delete from origin_access_grants
                 where ctid in (
                   select ctid
                   from origin_access_grants
                   where expires_at < now() - ($1::bigint * interval '1 second')
                   limit $2
                 )",
                &[
                    &ACCESS_GRANT_RETENTION_SECONDS,
                    &ACCESS_GRANT_CLEANUP_BATCH_SIZE,
                ],
            )
            .await
            .context("failed to prune expired origin access grants")?;
        total_deleted += deleted;
        if deleted < ACCESS_GRANT_CLEANUP_BATCH_SIZE as u64 {
            break;
        }
    }

    if total_deleted > 0 {
        tracing::info!(
            deleted = total_deleted,
            "pruned expired origin_access_grants"
        );
    }

    Ok(total_deleted)
}

// -----------------------------------------------------------------------------
// HTTP routing
// -----------------------------------------------------------------------------

const ORIGIN_PROXY_READ_SCOPES: &[&str] = &["fs.read"];
const ORIGIN_PROXY_WRITE_SCOPES: &[&str] = &["fs.write"];
const ORIGIN_PROXY_BROWSER_VIEW_SCOPES: &[&str] = &["browser.view"];
const ORIGIN_PROXY_BROWSER_CONTROL_SCOPES: &[&str] = &["browser.control"];
const ORIGIN_PROXY_BROWSER_INTERACTIVE_SCOPES: &[&str] = &["browser.view", "browser.control"];
const ORIGIN_PROXY_MAX_BODY_BYTES: usize = 300 * 1024 * 1024;
const ORIGIN_PROXY_WEBRTC_BODY_BYTES: usize = 256 * 1024;
const ORIGIN_PROXY_BROWSER_APPROVAL_BODY_BYTES: usize = 16 * 1024;

fn controller_base_url_for_headers(config: &AppConfig, headers: &HeaderMap) -> Option<String> {
    if let Some(base) = config._controller_external_url.as_ref() {
        let trimmed = base.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    let host = headers.get(header::HOST)?.to_str().ok()?.trim().to_string();
    if host.is_empty() {
        return None;
    }

    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http".to_string());
    let scheme = if proto == "https" { "https" } else { "http" };

    Some(format!("{scheme}://{host}"))
}

fn origin_endpoint_is_proxyable(endpoint: &str) -> bool {
    let url = match reqwest::Url::parse(endpoint.trim()) {
        Ok(url) => url,
        Err(_) => return false,
    };

    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return false;
    }

    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    let host = match url.host_str() {
        Some(host) => host,
        None => return false,
    };

    host == "rt.instafy.dev"
        || host.ends_with(".rt.instafy.dev")
        // Local dev tunnel broker uses `.rt.test` hostnames (typically not resolvable via OS DNS).
        || host == "rt.test"
        || host.ends_with(".rt.test")
        // Local dev: hosted origin gateway defaults to 127.0.0.1 (host), but docker runtimes cannot
        // reach it directly. Proxy it through the controller instead.
        || host == "127.0.0.1"
        // Some environments will use the docker host gateway hostname.
        || host == "host.docker.internal"
        // Hosted origins often surface as RFC1918 cluster IPs (for example 10.99.x.x).
        // Proxy those through the controller so browsers never fetch private HTTP origins directly.
        || is_private_or_local_ip_host(host)
}

fn is_private_or_local_ip_host(host: &str) -> bool {
    let ip = match host.parse::<IpAddr>() {
        Ok(value) => value,
        Err(_) => return false,
    };

    match ip {
        IpAddr::V4(addr) => {
            let octets = addr.octets();
            let is_cgnat = octets[0] == 100 && (octets[1] & 0b1100_0000) == 0b0100_0000;
            let is_benchmark = octets[0] == 198 && (octets[1] == 18 || octets[1] == 19);
            addr.is_private()
                || addr.is_loopback()
                || addr.is_link_local()
                || addr.is_broadcast()
                || addr.is_unspecified()
                || is_cgnat
                || is_benchmark
        }
        IpAddr::V6(addr) => {
            addr.is_loopback()
                || addr.is_unspecified()
                || addr.is_unique_local()
                || addr.is_unicast_link_local()
        }
    }
}

fn normalize_origin_proxy_upstream_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return trimmed;
    }

    // `host.docker.internal` is only resolvable inside Docker (Mac/Windows by default). When running
    // the controller as a host process (e.g. `pnpm stack:up`), rewrite it so origin proxying works.
    let controller_running_in_docker = std::path::Path::new("/.dockerenv").exists();
    if controller_running_in_docker {
        return trimmed;
    }

    match reqwest::Url::parse(&trimmed) {
        Ok(mut url) => {
            if url.host_str() == Some("host.docker.internal") {
                let _ = url.set_host(Some("127.0.0.1"));
            }
            url.to_string().trim_end_matches('/').to_string()
        }
        Err(_) => trimmed
            .replace("host.docker.internal", "127.0.0.1")
            .trim_end_matches('/')
            .to_string(),
    }
}

fn parse_default_gateway_ipv4(route_table: &str) -> Option<Ipv4Addr> {
    // Linux `/proc/net/route` encodes gateway values as little-endian hex.
    route_table.lines().skip(1).find_map(|line| {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 4 {
            return None;
        }
        if columns[1] != "00000000" {
            return None;
        }

        let flags = u16::from_str_radix(columns[3], 16).ok()?;
        if (flags & 0x2) == 0 {
            return None;
        }

        let gateway_raw = u32::from_str_radix(columns[2], 16).ok()?;
        if gateway_raw == 0 {
            return None;
        }
        Some(Ipv4Addr::from(gateway_raw.to_le_bytes()))
    })
}

fn docker_default_gateway_ipv4() -> Option<Ipv4Addr> {
    let route_table = std::fs::read_to_string("/proc/net/route").ok()?;
    parse_default_gateway_ipv4(&route_table)
}

pub(crate) fn resolve_origin_proxy_upstream_endpoint(endpoint: &str) -> (String, Option<String>) {
    let trimmed = endpoint.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return (trimmed, None);
    }

    let parsed = match reqwest::Url::parse(&trimmed) {
        Ok(url) => url,
        Err(_) => return (normalize_origin_proxy_upstream_endpoint(&trimmed), None),
    };

    // When the controller runs inside Docker, `host.docker.internal` is available and `.rt.test`
    // hostnames are expected to resolve via the container's DNS configuration.
    let controller_running_in_docker = std::path::Path::new("/.dockerenv").exists();
    if controller_running_in_docker {
        if parsed.host_str() == Some("host.docker.internal") {
            if let Some(gateway) = docker_default_gateway_ipv4() {
                let mut rewritten = parsed;
                if rewritten
                    .set_host(Some(gateway.to_string().as_str()))
                    .is_ok()
                {
                    return (
                        rewritten.to_string().trim_end_matches('/').to_string(),
                        None,
                    );
                }
            }
        }
        return (trimmed, None);
    }

    // `host.docker.internal` is only resolvable inside Docker (Mac/Windows by default). When running
    // the controller as a host process (e.g. `pnpm stack:up`), rewrite it so origin proxying works.
    if parsed.host_str() == Some("host.docker.internal") {
        let mut url = parsed;
        let _ = url.set_host(Some("127.0.0.1"));
        return (url.to_string().trim_end_matches('/').to_string(), None);
    }

    let is_local_rt_test = parsed
        .host_str()
        .map(|host| host == "rt.test" || host.ends_with(".rt.test"))
        .unwrap_or(false);
    if is_local_rt_test {
        // `.rt.test` tunnel hostnames are not resolvable via OS DNS in most environments. Route
        // through the local tunnel-broker ingress while preserving the original Host header so
        // Traefik can dispatch to the correct tunnel backend.
        let host_header = parsed.host_str().map(|host| match parsed.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        });

        let mut url = parsed;
        let _ = url.set_host(Some("127.0.0.1"));
        return (
            url.to_string().trim_end_matches('/').to_string(),
            host_header,
        );
    }

    (trimmed, None)
}

fn origin_endpoint_for_client(
    config: &AppConfig,
    headers: &HeaderMap,
    origin_id: &Uuid,
    endpoint: &str,
) -> String {
    let normalized = endpoint.trim().trim_end_matches('/').to_string();
    if !origin_endpoint_is_proxyable(&normalized) {
        return normalized;
    }

    let Some(base_url) = controller_base_url_for_headers(config, headers) else {
        return normalized;
    };

    format!("{}/origin/{}", base_url.trim_end_matches('/'), origin_id)
}

#[derive(Debug, Deserialize)]
struct OriginProxyPathParams {
    origin_id: String,
}

#[derive(Debug, Deserialize)]
struct OriginProxyWsQuery {
    token: Option<String>,
    access_token: Option<String>,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
    width: Option<String>,
    height: Option<String>,
    dpr: Option<String>,
}

fn browser_screencast_forwarded_query(query: &OriginProxyWsQuery) -> Option<String> {
    let mut url = reqwest::Url::parse("http://localhost/").ok()?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in [
            ("pageId", query.page_id.as_deref()),
            ("width", query.width.as_deref()),
            ("height", query.height.as_deref()),
            ("dpr", query.dpr.as_deref()),
        ] {
            if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
                pairs.append_pair(key, value);
            }
        }
    }
    url.query().map(str::to_string)
}

fn split_origin_proxy_query(query: Option<&str>) -> (Option<String>, Option<String>) {
    let query = match query {
        Some(value) => value.trim(),
        None => return (None, None),
    };
    if query.is_empty() {
        return (None, None);
    }

    let parsed = match reqwest::Url::parse(&format!("http://localhost/?{query}")) {
        Ok(url) => url,
        Err(_) => return (None, Some(query.to_string())),
    };

    let mut token: Option<String> = None;
    let mut forwarded = match reqwest::Url::parse("http://localhost/") {
        Ok(url) => url,
        Err(_) => return (token, Some(query.to_string())),
    };

    {
        let mut pairs = forwarded.query_pairs_mut();
        for (key, value) in parsed.query_pairs() {
            if (key == "token" || key == "access_token") && token.is_none() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    token = Some(trimmed.to_string());
                }
                continue;
            }
            pairs.append_pair(&key, &value);
        }
    }

    (token, forwarded.query().map(|value| value.to_string()))
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct CanonicalOriginProxyPath {
    normalized: String,
    segments: Vec<String>,
}

fn decode_origin_proxy_path_segment(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }

        if index + 2 >= bytes.len() {
            return Err(bad_request("origin path contains invalid percent encoding"));
        }
        let high = hex_value(bytes[index + 1])
            .ok_or_else(|| bad_request("origin path contains invalid percent encoding"))?;
        let low = hex_value(bytes[index + 2])
            .ok_or_else(|| bad_request("origin path contains invalid percent encoding"))?;
        decoded.push((high << 4) | low);
        index += 3;
    }

    String::from_utf8(decoded).map_err(|_| bad_request("origin path must be valid UTF-8"))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn canonical_origin_proxy_path(
    path: &str,
) -> Result<CanonicalOriginProxyPath, (StatusCode, Json<ApiError>)> {
    let raw_path = path.strip_prefix('/').unwrap_or(path);
    if raw_path.is_empty() {
        return Err(not_found("origin path not found"));
    }

    let mut segments = Vec::new();
    for raw_segment in raw_path.split('/') {
        if raw_segment.is_empty() {
            return Err(bad_request("origin path contains an empty segment"));
        }
        let segment = decode_origin_proxy_path_segment(raw_segment)?;
        if segment == "." || segment == ".." {
            return Err(bad_request("origin path contains a dot segment"));
        }
        if segment.contains('/') || segment.contains('\\') {
            return Err(bad_request("origin path contains an encoded separator"));
        }
        // A decoded percent sign can hide a second encoded traversal or
        // separator from an upstream that performs more than one decode pass.
        if segment.contains('%') {
            return Err(bad_request("origin path contains nested percent encoding"));
        }
        if segment.chars().any(char::is_control) {
            return Err(bad_request("origin path contains a control character"));
        }
        segments.push(segment);
    }

    Ok(CanonicalOriginProxyPath {
        normalized: segments.join("/"),
        segments,
    })
}

fn build_origin_proxy_upstream_url(
    base: &str,
    path: &CanonicalOriginProxyPath,
    query: Option<&str>,
) -> Result<reqwest::Url, (StatusCode, Json<ApiError>)> {
    let mut upstream = reqwest::Url::parse(base)
        .map_err(|_| internal_error("invalid origin endpoint".to_string()))?;
    if upstream.query().is_some() || upstream.fragment().is_some() {
        return Err(internal_error(
            "origin endpoint must not include a query or fragment".to_string(),
        ));
    }

    {
        let mut path_segments = upstream
            .path_segments_mut()
            .map_err(|_| internal_error("invalid origin endpoint".to_string()))?;
        path_segments.pop_if_empty();
        for segment in &path.segments {
            path_segments.push(segment);
        }
    }
    upstream.set_query(query.filter(|value| !value.is_empty()));
    Ok(upstream)
}

fn classify_origin_proxy_request(
    method: &Method,
    path: &str,
) -> Result<&'static [&'static str], (StatusCode, Json<ApiError>)> {
    let canonical = canonical_origin_proxy_path(path)?;
    classify_canonical_origin_proxy_request(method, &canonical)
}

fn classify_canonical_origin_proxy_request(
    method: &Method,
    path: &CanonicalOriginProxyPath,
) -> Result<&'static [&'static str], (StatusCode, Json<ApiError>)> {
    let normalized = path.normalized.as_str();
    match *method {
        Method::GET | Method::HEAD => {
            if normalized == "browser/capabilities"
                || normalized == "browser/pages"
                || normalized == "browser/actions"
                || normalized == "browser/approval/pending"
            {
                Ok(ORIGIN_PROXY_BROWSER_VIEW_SCOPES)
            } else if normalized == "healthz"
                || normalized == "entries"
                || normalized.starts_with("files/")
                || normalized.starts_with("raw/")
                || normalized == "git/status"
                || normalized == "git/diff"
                || normalized == "git/history"
                || normalized == "git/history/review"
            {
                Ok(ORIGIN_PROXY_READ_SCOPES)
            } else {
                Err(not_found("origin path not found"))
            }
        }
        Method::POST => {
            if normalized == "apply" || normalized == "git/sync" || normalized == "git/revert" {
                Ok(ORIGIN_PROXY_WRITE_SCOPES)
            } else if normalized == "browser/webrtc/offer" {
                Ok(ORIGIN_PROXY_BROWSER_VIEW_SCOPES)
            } else if normalized == "browser/approval/decision" {
                Ok(ORIGIN_PROXY_BROWSER_CONTROL_SCOPES)
            } else if is_exact_browser_page_action(normalized, "focus")
                || is_exact_browser_page_action(normalized, "command")
            {
                Ok(ORIGIN_PROXY_BROWSER_CONTROL_SCOPES)
            } else {
                Err(not_found("origin path not found"))
            }
        }
        _ => Err((
            StatusCode::METHOD_NOT_ALLOWED,
            Json(ApiError::new("method not allowed")),
        )),
    }
}

fn origin_proxy_request_body_limit(method: &Method, path: &str) -> usize {
    match (method, path.trim().trim_start_matches('/')) {
        (&Method::POST, "browser/webrtc/offer") => ORIGIN_PROXY_WEBRTC_BODY_BYTES,
        (&Method::POST, "browser/approval/decision") => ORIGIN_PROXY_BROWSER_APPROVAL_BODY_BYTES,
        _ => ORIGIN_PROXY_MAX_BODY_BYTES,
    }
}

fn is_exact_browser_page_action(path: &str, action: &str) -> bool {
    let mut segments = path.split('/');
    matches!(
        (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next()
        ),
        (Some("browser"), Some("pages"), Some(page_id), Some(candidate), None)
            if !page_id.is_empty() && candidate == action
    )
}

pub(crate) fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

#[instrument(skip_all)]
async fn proxy_origin_vnc_ws(
    State(state): State<AppState>,
    Path(params): Path<OriginProxyPathParams>,
    headers: HeaderMap,
    Query(query): Query<OriginProxyWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    proxy_origin_browser_ws(
        state,
        params,
        headers,
        query,
        ws,
        "browser/vnc",
        BrowserRelayTransport::Rfb,
        None,
        ORIGIN_PROXY_BROWSER_INTERACTIVE_SCOPES,
    )
    .await
}

#[instrument(skip_all)]
async fn proxy_origin_screencast_ws(
    State(state): State<AppState>,
    Path(params): Path<OriginProxyPathParams>,
    headers: HeaderMap,
    Query(query): Query<OriginProxyWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let forwarded_query = browser_screencast_forwarded_query(&query);
    proxy_origin_browser_ws(
        state,
        params,
        headers,
        query,
        ws.max_message_size(16 * 1024).max_frame_size(16 * 1024),
        "browser/screencast",
        BrowserRelayTransport::CdpScreencast,
        forwarded_query,
        ORIGIN_PROXY_BROWSER_VIEW_SCOPES,
    )
    .await
}

#[instrument(skip_all)]
async fn proxy_origin_browser_input_ws(
    State(state): State<AppState>,
    Path(params): Path<OriginProxyPathParams>,
    headers: HeaderMap,
    Query(query): Query<OriginProxyWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let forwarded_query = browser_screencast_forwarded_query(&query);
    proxy_origin_browser_ws(
        state,
        params,
        headers,
        query,
        ws.max_message_size(16 * 1024).max_frame_size(16 * 1024),
        "browser/input",
        BrowserRelayTransport::CdpInput,
        forwarded_query,
        ORIGIN_PROXY_BROWSER_CONTROL_SCOPES,
    )
    .await
}

#[instrument(skip_all)]
async fn proxy_origin_browser_collaboration_ws(
    State(state): State<AppState>,
    Path(params): Path<OriginProxyPathParams>,
    headers: HeaderMap,
    Query(query): Query<OriginProxyWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    proxy_origin_browser_ws(
        state,
        params,
        headers,
        query,
        ws.max_message_size(8 * 1024).max_frame_size(8 * 1024),
        "browser/collaboration",
        BrowserRelayTransport::Collaboration,
        None,
        ORIGIN_PROXY_BROWSER_VIEW_SCOPES,
    )
    .await
}

async fn proxy_origin_browser_ws(
    state: AppState,
    params: OriginProxyPathParams,
    headers: HeaderMap,
    query: OriginProxyWsQuery,
    ws: WebSocketUpgrade,
    upstream_browser_path: &'static str,
    relay_transport: BrowserRelayTransport,
    forwarded_query: Option<String>,
    required_scopes: &'static [&'static str],
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let origin_id_value = params.origin_id.trim();
    let origin_id = parse_optional_uuid_param(Some(origin_id_value.to_string()), "originId")?
        .ok_or_else(|| bad_request("originId is required"))?;

    let token = bearer_token(&headers)
        .or_else(|| query.token.clone())
        .or_else(|| query.access_token.clone())
        .ok_or_else(|| unauthorized("origin endpoint requires scoped origin access token"))?;

    let claims = decode_scoped_token(&state.config, &token, "origin access token")?;

    let expected_origin_id = origin_id.to_string();
    if claims.origin_id.as_deref() != Some(expected_origin_id.as_str()) {
        return Err(unauthorized("token origin mismatch"));
    }
    if claims.aud != expected_origin_id {
        return Err(unauthorized("token audience mismatch"));
    }
    if !claims_have_scopes(&claims, required_scopes) {
        return Err(unauthorized("insufficient origin scopes"));
    }

    let origin = load_origin_by_id(&state.pool, &origin_id)
        .await
        .map_err(|error| internal_error(format!("failed to load origin: {error}")))?;
    let Some(origin) = origin else {
        return Err(not_found("origin not registered"));
    };

    if claims.project_id != origin.project_id.to_string() {
        return Err(unauthorized("token project mismatch"));
    }

    authorize_origin_proxy_token_runtime(&state, &origin, &claims).await?;

    if !origin_endpoint_is_proxyable(&origin.endpoint) {
        return Err(forbidden(
            "origin endpoint is not available through controller proxy",
        ));
    }

    let (base, host_override) = resolve_origin_proxy_upstream_endpoint(&origin.endpoint);
    let mut upstream = reqwest::Url::parse(&base)
        .map_err(|_| internal_error("invalid origin endpoint".to_string()))?;
    let scheme = upstream.scheme().to_ascii_lowercase();
    let ws_scheme = if scheme == "https" { "wss" } else { "ws" };
    upstream
        .set_scheme(ws_scheme)
        .map_err(|_| internal_error("invalid origin endpoint scheme".to_string()))?;

    let base_path = upstream.path().trim_end_matches('/');
    let path = if base_path.is_empty() || base_path == "/" {
        format!("/{upstream_browser_path}")
    } else {
        format!("{base_path}/{upstream_browser_path}")
    };
    upstream.set_path(&path);
    upstream.set_query(forwarded_query.as_deref());

    let upstream_url = upstream.to_string();
    let relay_context = BrowserRelayContext::new(
        relay_transport,
        claims.project_id,
        expected_origin_id,
        claims.runtime_id,
        query.page_id,
        claims.lease_id,
        claims.run_id,
    );
    Ok(ws.on_upgrade(move |socket| {
        bridge_origin_ws(socket, upstream_url, host_override, token, relay_context)
    }))
}

async fn bridge_origin_ws(
    socket: WebSocket,
    upstream_url: String,
    host_override: Option<String>,
    token: String,
    relay_context: BrowserRelayContext,
) {
    let mut relay_telemetry = BrowserRelayTelemetry::new(relay_context);
    let upstream_url_with_token = match reqwest::Url::parse(&upstream_url) {
        Ok(mut url) => {
            let has_scoped_token = url
                .query_pairs()
                .any(|(key, _)| key == "token" || key == "access_token");
            if !has_scoped_token {
                url.query_pairs_mut().append_pair("token", &token);
            }
            url.to_string()
        }
        Err(_) => upstream_url,
    };

    let mut request = match upstream_url_with_token.into_client_request() {
        Ok(req) => req,
        Err(error) => {
            warn!(?error, "failed to build origin browser websocket request");
            relay_telemetry.close(BrowserRelayOutcome::RequestBuildError);
            return;
        }
    };

    if let Ok(value) = axum::http::HeaderValue::from_str(&format!("Bearer {token}")) {
        request.headers_mut().insert(header::AUTHORIZATION, value);
    }
    if let Some(host) = host_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if let Ok(value) = axum::http::HeaderValue::from_str(host) {
            request.headers_mut().insert(header::HOST, value);
        }
    }

    let (upstream_ws, _response) = match connect_async(request).await {
        Ok(value) => value,
        Err(error) => {
            warn!(
                ?error,
                "failed to connect to upstream origin browser websocket"
            );
            relay_telemetry.close(BrowserRelayOutcome::OriginConnectError);
            return;
        }
    };

    let (mut client_sender, mut client_receiver) = socket.split();
    let (mut upstream_sender, mut upstream_receiver) = upstream_ws.split();

    let outcome = loop {
        tokio::select! {
            client_message = client_receiver.next() => {
                let Some(message_result) = client_message else {
                    break BrowserRelayOutcome::ClientEof;
                };
                match message_result {
                    Ok(WsMessage::Binary(data)) => {
                        relay_telemetry.observe(BrowserRelayDirection::ClientToOrigin, data.len());
                        if upstream_sender.send(TungMessage::Binary(data)).await.is_err() {
                            break BrowserRelayOutcome::OriginSendError;
                        }
                    }
                    Ok(WsMessage::Text(text)) => {
                        relay_telemetry.observe(BrowserRelayDirection::ClientToOrigin, text.len());
                        if upstream_sender.send(TungMessage::Text(text)).await.is_err() {
                            break BrowserRelayOutcome::OriginSendError;
                        }
                    }
                    Ok(WsMessage::Ping(payload)) => {
                        relay_telemetry.observe(BrowserRelayDirection::ClientToOrigin, payload.len());
                        if upstream_sender.send(TungMessage::Ping(payload)).await.is_err() {
                            break BrowserRelayOutcome::OriginSendError;
                        }
                    }
                    Ok(WsMessage::Pong(payload)) => {
                        relay_telemetry.observe(BrowserRelayDirection::ClientToOrigin, payload.len());
                        if upstream_sender.send(TungMessage::Pong(payload)).await.is_err() {
                            break BrowserRelayOutcome::OriginSendError;
                        }
                    }
                    Ok(WsMessage::Close(_)) => {
                        relay_telemetry.observe(BrowserRelayDirection::ClientToOrigin, 0);
                        let _ = upstream_sender.send(TungMessage::Close(None)).await;
                        break BrowserRelayOutcome::ClientClosed;
                    }
                    Err(error) => {
                        warn!(?error, "origin browser websocket client receive error");
                        break BrowserRelayOutcome::ClientReceiveError;
                    }
                }
            }
            upstream_message = upstream_receiver.next() => {
                let Some(message_result) = upstream_message else {
                    break BrowserRelayOutcome::OriginEof;
                };
                match message_result {
                    Ok(TungMessage::Binary(data)) => {
                        relay_telemetry.observe(BrowserRelayDirection::OriginToClient, data.len());
                        if client_sender.send(WsMessage::Binary(data)).await.is_err() {
                            break BrowserRelayOutcome::ClientSendError;
                        }
                    }
                    Ok(TungMessage::Text(text)) => {
                        relay_telemetry.observe(BrowserRelayDirection::OriginToClient, text.len());
                        if client_sender.send(WsMessage::Text(text)).await.is_err() {
                            break BrowserRelayOutcome::ClientSendError;
                        }
                    }
                    Ok(TungMessage::Ping(payload)) => {
                        relay_telemetry.observe(BrowserRelayDirection::OriginToClient, payload.len());
                        if client_sender.send(WsMessage::Ping(payload)).await.is_err() {
                            break BrowserRelayOutcome::ClientSendError;
                        }
                    }
                    Ok(TungMessage::Pong(payload)) => {
                        relay_telemetry.observe(BrowserRelayDirection::OriginToClient, payload.len());
                        if client_sender.send(WsMessage::Pong(payload)).await.is_err() {
                            break BrowserRelayOutcome::ClientSendError;
                        }
                    }
                    Ok(TungMessage::Close(_)) => {
                        relay_telemetry.observe(BrowserRelayDirection::OriginToClient, 0);
                        let _ = client_sender.send(WsMessage::Close(None)).await;
                        break BrowserRelayOutcome::OriginClosed;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        warn!(?error, "origin browser websocket upstream receive error");
                        break BrowserRelayOutcome::OriginReceiveError;
                    }
                }
            }
        }
    };

    relay_telemetry.close(outcome);

    let _ = client_sender.send(WsMessage::Close(None)).await;
    let _ = upstream_sender.send(TungMessage::Close(None)).await;
}

#[instrument(skip_all)]
async fn proxy_origin_request(
    State(state): State<AppState>,
    Path(params): Path<OriginProxyPathParams>,
    request: Request,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let origin_id_value = params.origin_id.trim();
    let origin_id = parse_optional_uuid_param(Some(origin_id_value.to_string()), "originId")?
        .ok_or_else(|| bad_request("originId is required"))?;

    let request_path = request.uri().path();
    let prefix = format!("/origin/{}", origin_id_value);
    let suffix = if request_path == prefix {
        ""
    } else {
        let prefix = format!("{}/", prefix);
        request_path
            .strip_prefix(&prefix)
            .unwrap_or_default()
            .trim()
    };

    let method = request.method().clone();
    let canonical_path = canonical_origin_proxy_path(suffix)?;
    let required_scopes = classify_canonical_origin_proxy_request(&method, &canonical_path)?;
    let is_webrtc_capabilities =
        method == Method::GET && canonical_path.normalized == "browser/capabilities";
    let is_webrtc_offer =
        method == Method::POST && canonical_path.normalized == "browser/webrtc/offer";
    let is_browser_approval_decision =
        method == Method::POST && canonical_path.normalized == "browser/approval/decision";
    let request_body_limit =
        origin_proxy_request_body_limit(&method, canonical_path.normalized.as_str());

    let headers = request.headers().clone();
    let (query_token, forwarded_query) = split_origin_proxy_query(request.uri().query());
    let token = bearer_token(&headers)
        .or(query_token)
        .ok_or_else(|| unauthorized("origin endpoint requires scoped origin access token"))?;

    let claims = decode_scoped_token(&state.config, &token, "origin access token")?;

    let expected_origin_id = origin_id.to_string();
    if claims.origin_id.as_deref() != Some(expected_origin_id.as_str()) {
        return Err(unauthorized("token origin mismatch"));
    }
    if claims.aud != expected_origin_id {
        return Err(unauthorized("token audience mismatch"));
    }
    if !claims_have_scopes(&claims, required_scopes) {
        return Err(unauthorized("insufficient origin scopes"));
    }

    let origin = load_origin_by_id(&state.pool, &origin_id)
        .await
        .map_err(|error| internal_error(format!("failed to load origin: {error}")))?;
    let Some(origin) = origin else {
        return Err(not_found("origin not registered"));
    };

    if claims.project_id != origin.project_id.to_string() {
        return Err(unauthorized("token project mismatch"));
    }

    authorize_origin_proxy_token_runtime(&state, &origin, &claims).await?;

    if !origin_endpoint_is_proxyable(&origin.endpoint) {
        return Err(forbidden(
            "origin endpoint is not available through controller proxy",
        ));
    }

    let (base, host_override) = resolve_origin_proxy_upstream_endpoint(&origin.endpoint);
    let url = build_origin_proxy_upstream_url(&base, &canonical_path, forwarded_query.as_deref())?;

    let upstream_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| bad_request("invalid proxy method"))?;
    let mut builder = state
        .origin_proxy_client
        .request(upstream_method, url)
        .bearer_auth(&token);
    if let Some(host) = host_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        builder = builder.header("host", host);
    }

    if let Some(value) = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
    {
        builder = builder.header("accept", value);
    }
    if let Some(value) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        builder = builder.header("content-type", value);
    }
    if let Some(value) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        builder = builder.header("range", value);
    }
    if let Some(value) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
    {
        builder = builder.header("if-none-match", value);
    }

    if is_webrtc_capabilities || is_webrtc_offer {
        let runtime_id = claims
            .runtime_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok());
        match browser_webrtc_proxy_policy(
            state.config.browser_turn_rest.as_ref(),
            origin.project_id,
            runtime_id,
            Utc::now().timestamp(),
        )
        .map_err(forbidden)?
        {
            BrowserWebRtcProxyPolicy::Unmanaged => {}
            BrowserWebRtcProxyPolicy::Disabled => {
                builder = builder.header(BROWSER_WEBRTC_POLICY_HEADER, "disabled");
            }
            BrowserWebRtcProxyPolicy::Relay(ice_servers) => {
                builder = builder
                    .header(BROWSER_WEBRTC_POLICY_HEADER, "relay")
                    .header(BROWSER_WEBRTC_ICE_SERVERS_HEADER, ice_servers);
            }
        }
    }

    let body = to_bytes(request.into_body(), request_body_limit)
        .await
        .map_err(|error| {
            if is_webrtc_offer {
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(ApiError::new("WebRTC offer exceeds 256 KiB")),
                )
            } else if is_browser_approval_decision {
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(ApiError::new("browser approval decision exceeds 16 KiB")),
                )
            } else {
                internal_error(format!("failed to read origin proxy request body: {error}"))
            }
        })?;

    let mut upstream = builder
        .body(body)
        .send()
        .await
        .map_err(|error| bad_gateway(format!("origin proxy request failed: {error}")))?;

    let status = upstream.status();
    let headers = upstream.headers().clone();
    let bytes = if is_webrtc_offer {
        let mut bounded = Vec::new();
        while let Some(chunk) = upstream.chunk().await.map_err(|error| {
            bad_gateway(format!(
                "failed to read origin proxy response body: {error}"
            ))
        })? {
            if bounded.len().saturating_add(chunk.len()) > ORIGIN_PROXY_WEBRTC_BODY_BYTES {
                return Err(bad_gateway("WebRTC answer exceeds 256 KiB"));
            }
            bounded.extend_from_slice(&chunk);
        }
        Bytes::from(bounded)
    } else {
        upstream.bytes().await.map_err(|error| {
            bad_gateway(format!(
                "failed to read origin proxy response body: {error}"
            ))
        })?
    };

    let status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::builder().status(status);
    for (name, value) in headers.iter() {
        if is_hop_by_hop_header(name.as_str()) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            response = response.header(name.as_str(), value);
        }
    }

    response
        .body(Body::from(bytes))
        .map_err(|error| internal_error(format!("failed to build origin proxy response: {error}")))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/origin/register", post(post_origin_register))
        .route("/origin/:origin_id/browser/vnc", get(proxy_origin_vnc_ws))
        .route(
            "/origin/:origin_id/browser/screencast",
            get(proxy_origin_screencast_ws),
        )
        .route(
            "/origin/:origin_id/browser/input",
            get(proxy_origin_browser_input_ws),
        )
        .route(
            "/origin/:origin_id/browser/collaboration",
            get(proxy_origin_browser_collaboration_ws),
        )
        .route("/origin/:origin_id", any(proxy_origin_request))
        .route("/origin/:origin_id/*path", any(proxy_origin_request))
        .route("/projects/:project_id/origin", get(get_project_origin))
        .route(
            "/projects/:project_id/origin/presence/beat",
            post(post_presence_beat_project),
        )
        .route("/projects/:project_id/git/shard", get(get_git_shard_route))
        .route(
            "/projects/:project_id/git/access_token",
            post(post_git_access_token),
        )
        .route("/.well-known/jwks.json", get(get_origin_jwks))
        .route("/commit/receipt", post(post_commit_receipt))
        .route("/projects/:project_id/lease", get(get_project_lease))
        .route("/lease/acquire", post(post_lease_acquire))
        .route("/lease/renew", post(post_lease_renew))
        .route("/lease/release", post(post_lease_release))
        .route("/access_token", post(post_access_token))
}

#[derive(Debug, Deserialize)]
struct ProjectOriginPathParams {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectOriginQuery {
    protocol: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginPresencePayload {
    status: String,
    last_heartbeat: String,
    latency_ms: Option<i32>,
    region: Option<String>,
    metadata: Option<JsonValue>,
    updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginRegisterBody {
    pub project_id: String,
    pub origin_id: String,
    pub mode: Option<String>,
    pub endpoint: String,
    pub protocols: Option<Vec<String>>,
    pub region: Option<String>,
    pub device_id: Option<String>,
    pub metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginRegisterResponse {
    pub origin_id: Uuid,
    pub project_id: Uuid,
    pub mode: String,
    pub endpoint: String,
    pub protocols: Vec<String>,
    pub region: Option<String>,
    pub device_id: Option<String>,
    pub metadata: Option<JsonValue>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectOriginResponse {
    project_id: Uuid,
    origin_id: Uuid,
    runtime_id: Option<Uuid>,
    mode: String,
    endpoint: String,
    protocols: Vec<String>,
    region: Option<String>,
    device_id: Option<String>,
    metadata: Option<JsonValue>,
    presence: Option<OriginPresencePayload>,
}

#[instrument(skip_all)]
pub(crate) async fn post_origin_register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<OriginRegisterBody>,
) -> Result<Json<OriginRegisterResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_optional_uuid_param(Some(body.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let origin_id = parse_optional_uuid_param(Some(body.origin_id), "originId")?
        .ok_or_else(|| bad_request("originId is required"))?;

    let claims =
        authorize_origin_request(&state, &headers, &project_id, &["origin.register"]).await?;

    // Reject SSRF-shaped endpoints (embedded credentials, non-HTTP schemes,
    // query/fragment payloads) and canonicalize before the binding checks so
    // tunnel/re-registration comparisons are exact.
    let endpoint = normalize_origin_registration_endpoint(&body.endpoint)?;

    let mut protocols = body.protocols.unwrap_or_else(|| vec!["http".to_string()]);
    protocols = protocols
        .into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect();
    protocols.sort();
    protocols.dedup();
    if protocols.is_empty() {
        return Err(bad_request("protocols must not be empty"));
    }

    let mode_value = body.mode.unwrap_or_else(|| "desktop".to_string());
    let mode = OriginMode::from_str(mode_value.to_ascii_lowercase().as_str())
        .map_err(|_| bad_request("mode must be 'desktop', 'efs', or 'hosted'"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start origin registration: {error}")))?;
    let origin = register_runtime_bound_origin(
        &state,
        &transaction,
        &project_id,
        &origin_id,
        mode,
        &endpoint,
        &protocols,
        body.region.as_deref(),
        body.device_id.as_deref(),
        body.metadata.as_ref(),
        &claims,
    )
    .await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit origin registration transaction: {error}"
        ))
    })?;

    publish_controller_event(
        &state.events,
        "origin.registered",
        Some(origin.project_id),
        None,
        None,
        None,
        origin_event_payload(&origin, None),
    );

    Ok(Json(OriginRegisterResponse {
        origin_id: origin.id,
        project_id: origin.project_id,
        mode: origin.mode.as_str().to_string(),
        endpoint: origin.endpoint.clone(),
        protocols: origin.protocols.clone(),
        region: origin.region.clone(),
        device_id: origin.device_id.clone(),
        metadata: origin.metadata.clone(),
        created_at: origin.created_at.to_rfc3339(),
        updated_at: origin.updated_at.to_rfc3339(),
    }))
}

#[instrument(skip_all)]
async fn get_project_origin(
    State(state): State<AppState>,
    Path(params): Path<ProjectOriginPathParams>,
    Query(query): Query<ProjectOriginQuery>,
    headers: HeaderMap,
) -> Result<Json<ProjectOriginResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;

    let project_id = parse_optional_uuid_param(Some(params.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;

    let _project = load_and_authorize_project(&state, &project_id, &context).await?;
    let subject_user_id = if let Some(user_id) = context.user_id {
        user_id
    } else if context.is_service_role {
        resolve_service_role_subject_user(&state)
            .await?
            .ok_or_else(|| unauthorized("service runtime user is not configured"))?
    } else {
        return Err(unauthorized(
            "authentication required to resolve project origin",
        ));
    };

    let protocol = query
        .protocol
        .unwrap_or_else(|| "webdav".to_string())
        .to_lowercase();

    let resolved = resolve_accessible_origin_for_protocol_with_hosted_fallback(
        &state,
        &project_id,
        &protocol,
        subject_user_id,
        context.is_service_role,
    )
    .await?;

    let Some(resolved) = resolved else {
        return Err(not_found("origin not found for requested protocol"));
    };

    let presence = resolved.presence.map(|presence| OriginPresencePayload {
        status: presence.status.as_str().to_string(),
        last_heartbeat: presence.last_heartbeat.to_rfc3339(),
        latency_ms: presence.latency_ms,
        region: presence.region.clone(),
        metadata: presence.metadata.clone(),
        updated_at: presence.updated_at.to_rfc3339(),
    });

    let endpoint = origin_endpoint_for_client(
        &state.config,
        &headers,
        &resolved.origin.id,
        &resolved.origin.endpoint,
    );
    // A user-driven write acquires its workspace lease before minting the
    // origin token. Return the controller-verified runtime binding so the
    // client can bind that lease to the same runtime that will receive the
    // write. Unbound hosted gateways intentionally return null.
    let runtime_id = load_origin_runtime_binding(&state.pool, &resolved.origin, None)
        .await
        .map_err(|error| {
            internal_error(format!("failed to resolve project origin runtime: {error}"))
        })?
        .map(|binding| binding.runtime_id);

    Ok(Json(ProjectOriginResponse {
        project_id,
        origin_id: resolved.origin.id,
        runtime_id,
        mode: resolved.origin.mode.as_str().to_string(),
        endpoint,
        protocols: resolved.origin.protocols,
        region: resolved.origin.region,
        device_id: resolved.origin.device_id,
        metadata: resolved.origin.metadata,
        presence,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, HeaderMap, HeaderValue};
    use chrono::Duration as ChronoDuration;
    use jsonwebtoken::{
        decode, encode, Algorithm, DecodingKey, EncodingKey, Header as JwtHeader, Validation,
    };
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    struct GeneratedEd25519Pem {
        private_pem: String,
        public_pem: String,
        public_key: Vec<u8>,
    }

    const ED25519_PUBLIC_KEY_SPKI_PREFIX: &[u8] = &[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];

    fn generated_ed25519_pem() -> GeneratedEd25519Pem {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate keypair");
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse keypair");

        let public_key = key_pair.public_key().as_ref().to_vec();
        let mut public_der = ED25519_PUBLIC_KEY_SPKI_PREFIX.to_vec();
        public_der.extend_from_slice(&public_key);

        GeneratedEd25519Pem {
            private_pem: format_pem_block("PRIVATE KEY", pkcs8.as_ref()),
            public_pem: format_pem_block("PUBLIC KEY", &public_der),
            public_key,
        }
    }

    fn format_pem_block(label: &str, der: &[u8]) -> String {
        let body = STANDARD.encode(der);
        let mut pem = format!("-----BEGIN {label}-----\n");
        for chunk in body.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(chunk).expect("base64 chunk utf8"));
            pem.push('\n');
        }
        pem.push_str(&format!("-----END {label}-----\n"));
        pem
    }

    #[test]
    fn private_origin_identity_is_controller_bound_to_its_runtime() {
        let runtime_id = Uuid::new_v4();
        let other_project_id = Uuid::new_v4();
        let future_hosted_origin_id = hosted_origin_id_for_project(&other_project_id);

        assert_eq!(
            expected_runtime_bound_origin_id(None, true, runtime_id),
            Some(runtime_id)
        );
        assert_ne!(runtime_id, future_hosted_origin_id);
        assert_ne!(
            expected_runtime_bound_origin_id(None, true, runtime_id),
            Some(future_hosted_origin_id),
            "a private runtime must not preclaim another project's deterministic hosted origin id"
        );
    }

    #[test]
    fn preallocated_origin_identity_preserves_managed_and_private_bindings() {
        let runtime_id = Uuid::new_v4();
        let instance_id = Uuid::new_v4();
        let bound_origin_id = Uuid::new_v4();
        let unbound = OriginRegistrationInstance {
            id: instance_id,
            origin_id: None,
            mode: None,
        };
        let bound = OriginRegistrationInstance {
            id: instance_id,
            origin_id: Some(bound_origin_id),
            mode: None,
        };

        assert_eq!(
            expected_runtime_bound_origin_id(Some(&unbound), false, runtime_id),
            Some(instance_id)
        );
        assert_eq!(
            expected_runtime_bound_origin_id(Some(&unbound), true, runtime_id),
            Some(runtime_id)
        );
        assert_eq!(
            expected_runtime_bound_origin_id(Some(&bound), true, runtime_id),
            Some(bound_origin_id)
        );
    }

    #[test]
    fn generic_single_writer_shape_excludes_scoped_or_coordinated_jobs() {
        assert!(job_is_generic_single_writer(
            &json!({ "writeIntent": true, "metadata": {} }),
            None,
        ));
        assert!(!job_is_generic_single_writer(
            &json!({ "writeIntent": false, "metadata": {} }),
            None,
        ));
        assert!(!job_is_generic_single_writer(
            &json!({ "writeIntent": true, "metadata": {} }),
            Some(Uuid::new_v4()),
        ));

        for mode in [
            "read_only",
            "readonly",
            "coordination-required",
            "owned",
            "exact",
            "path-owned",
            "write",
            "write_scoped",
        ] {
            assert!(
                !job_is_generic_single_writer(
                    &json!({
                        "writeIntent": true,
                        "metadata": { "writeScope": { "mode": mode } },
                    }),
                    None,
                ),
                "mode {mode} must not receive raw git.write",
            );
            assert!(
                !job_is_generic_single_writer(
                    &json!({
                        "metadata": {
                            "write_intent": true,
                            "agent": { "write_scope": { "mode": mode } },
                        },
                    }),
                    None,
                ),
                "nested mode {mode} must not receive raw git.write",
            );
        }
    }

    #[test]
    fn legacy_prompt_workspace_mutation_is_limited_to_generic_single_writer_jobs() {
        assert!(legacy_prompt_can_mutate_workspace(
            &json!({ "writeIntent": true, "metadata": {} }),
            None,
        ));
        assert!(!legacy_prompt_can_mutate_workspace(
            &json!({
                "writeIntent": true,
                "metadata": { "writeScope": { "mode": "path-owned" } },
            }),
            None,
        ));
        assert!(!legacy_prompt_can_mutate_workspace(
            &json!({
                "writeIntent": true,
                "metadata": { "writeScope": { "mode": "read-only" } },
            }),
            None,
        ));
        assert!(!legacy_prompt_can_mutate_workspace(
            &json!({ "writeIntent": true, "metadata": {} }),
            Some(Uuid::new_v4()),
        ));
    }

    #[test]
    fn separated_workspace_mutation_requires_explicit_write_intent() {
        assert!(job_allows_workspace_mutation(&json!({
            "writeIntent": true,
            "metadata": {},
        })));
        assert!(!job_allows_workspace_mutation(&json!({
            "writeIntent": false,
            "metadata": {},
        })));
        assert!(!job_allows_workspace_mutation(&json!({ "metadata": {} })));
        assert!(!job_allows_workspace_mutation(&json!({
            "writeIntent": true,
            "metadata": { "writeScope": { "mode": "read-only" } },
        })));
    }

    #[test]
    fn direct_runtime_and_job_git_credentials_are_strictly_read_only() {
        assert!(git_scopes_are_read_only(&["git.read".to_string()]));
        assert!(!git_scopes_are_read_only(&["git.write".to_string()]));
        assert!(!git_scopes_are_read_only(&[
            "git.read".to_string(),
            "git.write".to_string(),
        ]));
        assert!(!git_scopes_are_read_only(&[]));
    }

    #[test]
    fn runtime_machine_capabilities_fence_quarantined_or_stale_generations() {
        let lease_id = Uuid::new_v4();
        assert!(runtime_capability_state_is_live("ready", None, None, None));
        assert!(runtime_capability_state_is_live(
            "running",
            Some(lease_id),
            Some("active"),
            None,
        ));
        assert!(runtime_capability_state_is_live(
            "draining",
            Some(lease_id),
            Some("active"),
            None,
        ));
        assert!(!runtime_capability_state_is_live(
            "requested",
            Some(lease_id),
            Some("cleanup_pending"),
            None,
        ));
        assert!(!runtime_capability_state_is_live(
            "running",
            Some(lease_id),
            Some("released"),
            Some(Utc::now()),
        ));
        assert!(!runtime_capability_state_is_live(
            "stopped", None, None, None,
        ));
    }

    fn origin_identity_claims(
        project_id: Uuid,
        origin_id: Uuid,
        runtime_id: Option<Uuid>,
    ) -> AccessTokenClaims {
        let audience = runtime_id.unwrap_or(origin_id);
        AccessTokenClaims {
            aud: audience.to_string(),
            sub: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: runtime_id.map(|value| value.to_string()),
            protocol: None,
            scopes: vec!["origin.register".to_string()],
            lease_id: None,
            runtime_generation: None,
            run_id: None,
            iat: Utc::now().timestamp(),
            exp: (Utc::now() + ChronoDuration::minutes(5)).timestamp(),
            jti: Uuid::new_v4().to_string(),
            prefer_runtime: runtime_id.map(|value| value.to_string()),
            actor_label: None,
            browser_session_id: None,
        }
    }

    #[test]
    fn origin_identity_claims_bind_audience_origin_and_runtime() {
        let project_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();

        let valid = origin_identity_claims(project_id, origin_id, Some(runtime_id));
        assert_eq!(
            validate_origin_identity_claims(&valid, &project_id, &origin_id)
                .unwrap()
                .runtime_id,
            Some(runtime_id)
        );

        let mut wrong_audience = valid.clone();
        wrong_audience.aud = project_id.to_string();
        assert!(validate_origin_identity_claims(&wrong_audience, &project_id, &origin_id).is_err());

        let mut wrong_origin = valid.clone();
        wrong_origin.origin_id = Some(Uuid::new_v4().to_string());
        assert!(validate_origin_identity_claims(&wrong_origin, &project_id, &origin_id).is_err());

        let mut disagreeing_runtime = valid;
        disagreeing_runtime.prefer_runtime = Some(Uuid::new_v4().to_string());
        assert!(
            validate_origin_identity_claims(&disagreeing_runtime, &project_id, &origin_id).is_err()
        );
    }

    #[test]
    fn origin_registration_endpoint_rejects_ssrf_shaping() {
        assert_eq!(
            normalize_origin_registration_endpoint("https://origin.example/").unwrap(),
            "https://origin.example"
        );
        assert!(normalize_origin_registration_endpoint("file:///etc/passwd").is_err());
        assert!(normalize_origin_registration_endpoint("http://user:pass@127.0.0.1").is_err());
        assert!(
            normalize_origin_registration_endpoint("http://127.0.0.1/?target=metadata").is_err()
        );
        assert!(normalize_origin_registration_endpoint("http://127.0.0.1/#fragment").is_err());
    }

    #[test]
    fn build_origin_jwks_handles_pem_public_key() {
        let pem = "-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFQAEX0aYqix3VQUBg05FFISGxhx2Ry93VE51GzM5iXA=
-----END PUBLIC KEY-----";

        let jwks =
            build_origin_jwks_from_pem(None, Some(pem), Some("test-kid")).expect("jwks build");
        let keys = jwks
            .get("keys")
            .and_then(JsonValue::as_array)
            .expect("keys array");
        assert_eq!(keys.len(), 1);
        let key = &keys[0];
        assert_eq!(key.get("kty").and_then(JsonValue::as_str), Some("OKP"));
        assert_eq!(key.get("crv").and_then(JsonValue::as_str), Some("Ed25519"));
        assert_eq!(key.get("alg").and_then(JsonValue::as_str), Some("EdDSA"));
        assert_eq!(key.get("kid").and_then(JsonValue::as_str), Some("test-kid"));
        let x = key
            .get("x")
            .and_then(JsonValue::as_str)
            .expect("x present")
            .to_string();
        assert_eq!(x, "FQAEX0aYqix3VQUBg05FFISGxhx2Ry93VE51GzM5iXA");
    }

    #[test]
    fn build_origin_jwks_handles_pem_private_key() {
        let pem = generated_ed25519_pem();

        let jwks = build_origin_jwks_from_pem(Some(&pem.private_pem), None, Some("test-kid"))
            .expect("jwks build");
        let keys = jwks
            .get("keys")
            .and_then(JsonValue::as_array)
            .expect("keys array");
        assert_eq!(keys.len(), 1);
        let key = &keys[0];
        assert_eq!(key.get("kid").and_then(JsonValue::as_str), Some("test-kid"));

        let raw_from_jwks = URL_SAFE_NO_PAD
            .decode(
                key.get("x")
                    .and_then(JsonValue::as_str)
                    .expect("x present")
                    .as_bytes(),
            )
            .expect("decode x");

        assert_eq!(raw_from_jwks.as_slice(), pem.public_key.as_slice());
    }

    #[test]
    fn build_origin_jwks_handles_combined_private_and_public_pem() {
        let pem = generated_ed25519_pem();
        let combined = format!("{}\n{}", pem.private_pem, pem.public_pem);

        let jwks = build_origin_jwks_from_pem(Some(&combined), None, Some("test-kid"))
            .expect("jwks build");
        let keys = jwks
            .get("keys")
            .and_then(JsonValue::as_array)
            .expect("keys array");
        assert_eq!(keys.len(), 1);
        let key = &keys[0];
        assert_eq!(key.get("kid").and_then(JsonValue::as_str), Some("test-kid"));

        let raw_from_jwks = URL_SAFE_NO_PAD
            .decode(
                key.get("x")
                    .and_then(JsonValue::as_str)
                    .expect("x present")
                    .as_bytes(),
            )
            .expect("decode x");

        assert_eq!(raw_from_jwks.as_slice(), pem.public_key.as_slice());
    }

    #[test]
    fn classify_origin_proxy_request_allows_history_review_reads() {
        let scopes = classify_origin_proxy_request(&Method::GET, "/git/history/review")
            .expect("history review should be proxyable");
        assert_eq!(scopes, ORIGIN_PROXY_READ_SCOPES);
    }

    #[test]
    fn origin_proxy_path_rejects_traversal_and_ambiguous_encodings() {
        for path in [
            "/raw/../metadata",
            "/raw/./metadata",
            "/raw/%2e%2e/metadata",
            "/raw/%2E%2E/metadata",
            "/raw/%2e./metadata",
            "/raw/.%2E/metadata",
            "/raw/%252e%252e/metadata",
            "/raw/%2fmetadata",
            "/raw/%2Fmetadata",
            "/raw/%5cmetadata",
            "/raw/\\metadata",
            "/raw/%252fmetadata",
            "/raw/%00metadata",
            "/raw/%1fmetadata",
            "/raw/%7fmetadata",
            "/raw/%C2%85metadata",
            "/raw//metadata",
            "/raw/metadata/",
            "/raw/%",
            "/raw/%2",
            "/raw/%GG",
            "/raw/%ff",
        ] {
            assert!(
                canonical_origin_proxy_path(path).is_err(),
                "unsafe origin proxy path was accepted: {path}"
            );
            assert!(
                classify_origin_proxy_request(&Method::GET, path).is_err(),
                "unsafe origin proxy path reached the route allowlist: {path}"
            );
        }
    }

    #[test]
    fn origin_proxy_path_is_decoded_once_and_appended_as_segments() {
        let path = canonical_origin_proxy_path("/%72aw/folder/hello%20world/%E2%9C%93.txt")
            .expect("safe encoded path");
        assert_eq!(path.normalized, "raw/folder/hello world/✓.txt");
        assert_eq!(
            classify_canonical_origin_proxy_request(&Method::GET, &path)
                .expect("decoded raw path should be proxyable"),
            ORIGIN_PROXY_READ_SCOPES,
        );

        let upstream = build_origin_proxy_upstream_url(
            "http://10.99.0.80:8788/gateway",
            &path,
            Some("download=1"),
        )
        .expect("safe upstream URL");
        assert_eq!(
            upstream.as_str(),
            "http://10.99.0.80:8788/gateway/raw/folder/hello%20world/%E2%9C%93.txt?download=1"
        );
    }

    #[test]
    fn origin_proxy_upstream_url_rejects_ambiguous_base_query_or_fragment() {
        let path = canonical_origin_proxy_path("/healthz").expect("health path");
        assert!(build_origin_proxy_upstream_url(
            "http://127.0.0.1:8788/?target=internal",
            &path,
            None
        )
        .is_err());
        assert!(
            build_origin_proxy_upstream_url("http://127.0.0.1:8788/#internal", &path, None)
                .is_err()
        );
    }

    #[test]
    fn browser_session_identity_is_required_and_bounded_for_browser_tokens() {
        assert_eq!(
            normalize_browser_session_id(Some("tab-123"), true).expect("valid browser session"),
            Some("tab-123".to_string())
        );
        assert!(normalize_browser_session_id(None, true).is_err());
        assert!(normalize_browser_session_id(Some("contains spaces"), true).is_err());
        assert!(normalize_browser_session_id(Some(&"x".repeat(129)), true).is_err());
        assert!(normalize_browser_session_id(Some("tab-123"), false).is_err());
        assert_eq!(
            normalize_browser_session_id(None, false).expect("non-browser token"),
            None
        );
    }

    #[test]
    fn browser_actor_labels_are_normalized_without_breaking_utf8() {
        assert_eq!(
            truncate_browser_actor_label("  Ada   Lovelace  "),
            "Ada Lovelace"
        );
        let bounded = truncate_browser_actor_label(&"å".repeat(80));
        assert!(bounded.len() <= BROWSER_ACTOR_LABEL_MAX_BYTES);
        assert!(bounded.is_char_boundary(bounded.len()));
    }

    #[test]
    fn classify_origin_proxy_request_allows_browser_metadata_reads() {
        for path in [
            "/browser/capabilities",
            "/browser/pages",
            "/browser/actions",
            "/browser/approval/pending",
        ] {
            let scopes = classify_origin_proxy_request(&Method::GET, path)
                .expect("browser metadata should be proxyable");
            assert_eq!(scopes, ORIGIN_PROXY_BROWSER_VIEW_SCOPES, "path: {path}");
        }
    }

    #[test]
    fn classify_origin_proxy_request_requires_control_for_exact_browser_approval_decision() {
        let scopes = classify_origin_proxy_request(&Method::POST, "/browser/approval/decision")
            .expect("browser approval decision should be proxyable");
        assert_eq!(scopes, ORIGIN_PROXY_BROWSER_CONTROL_SCOPES);
        assert_eq!(
            origin_proxy_request_body_limit(&Method::POST, "/browser/approval/decision"),
            ORIGIN_PROXY_BROWSER_APPROVAL_BODY_BYTES,
        );
        assert_eq!(
            origin_proxy_request_body_limit(&Method::POST, "/browser/approval/decision/"),
            ORIGIN_PROXY_MAX_BODY_BYTES,
            "nearby paths must not inherit the approval body limit or allowlist identity",
        );

        for path in [
            "/browser/approval/decision/",
            "/browser/approval/decisions",
            "/browser/approval/nested/decision",
        ] {
            assert!(
                classify_origin_proxy_request(&Method::POST, path).is_err(),
                "unexpected proxy allowlist match: {path}"
            );
        }
    }

    #[test]
    fn screencast_proxy_forwards_only_bounded_transport_parameters() {
        let query = OriginProxyWsQuery {
            token: Some("secret".to_string()),
            access_token: None,
            page_id: Some("PAGE-1".to_string()),
            width: Some("1280".to_string()),
            height: Some("720".to_string()),
            dpr: Some("2".to_string()),
        };
        let forwarded = browser_screencast_forwarded_query(&query).expect("forwarded query");
        assert!(forwarded.contains("pageId=PAGE-1"));
        assert!(forwarded.contains("width=1280"));
        assert!(forwarded.contains("height=720"));
        assert!(forwarded.contains("dpr=2"));
        assert!(!forwarded.contains("secret"));
        assert!(!forwarded.contains("token"));
    }

    #[test]
    fn classify_origin_proxy_request_requires_control_for_exact_browser_commands() {
        let scopes = classify_origin_proxy_request(&Method::POST, "/browser/pages/ABC123/command")
            .expect("browser command should be proxyable");
        assert_eq!(scopes, ORIGIN_PROXY_BROWSER_CONTROL_SCOPES);

        let focus_scopes =
            classify_origin_proxy_request(&Method::POST, "/browser/pages/ABC123/focus")
                .expect("browser focus should be proxyable");
        assert_eq!(focus_scopes, ORIGIN_PROXY_BROWSER_CONTROL_SCOPES);

        for path in [
            "/browser/pages/ABC123/command/",
            "/browser/pages/ABC123/nested/command",
            "/browser/pages//command",
            "/browser/pages/ABC123/commands",
        ] {
            assert!(
                classify_origin_proxy_request(&Method::POST, path).is_err(),
                "unexpected proxy allowlist match: {path}"
            );
        }
    }

    #[test]
    fn classify_origin_proxy_request_requires_view_for_webrtc_offer() {
        let scopes = classify_origin_proxy_request(&Method::POST, "/browser/webrtc/offer")
            .expect("WebRTC offer should be proxyable");
        assert_eq!(scopes, ORIGIN_PROXY_BROWSER_VIEW_SCOPES);

        for path in [
            "/browser/webrtc/offer/",
            "/browser/webrtc/offers",
            "/browser/webrtc/nested/offer",
        ] {
            assert!(
                classify_origin_proxy_request(&Method::POST, path).is_err(),
                "unexpected proxy allowlist match: {path}"
            );
        }
    }

    #[test]
    fn managed_webrtc_policy_mints_fresh_per_negotiation_credentials() {
        let project_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let runtime_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let config = crate::browser_turn::BrowserTurnRestConfig::for_test_projects(
            "turns:turn.example.test:443",
            "0123456789abcdef0123456789abcdef",
            600,
            &project_id.to_string(),
        );

        let first =
            browser_webrtc_proxy_policy(Some(&config), project_id, Some(runtime_id), 1_700_000_000)
                .expect("first policy");
        let refreshed =
            browser_webrtc_proxy_policy(Some(&config), project_id, Some(runtime_id), 1_700_000_601)
                .expect("refreshed policy");
        assert_ne!(first, refreshed);
        assert!(matches!(first, BrowserWebRtcProxyPolicy::Relay(_)));

        let denied = browser_webrtc_proxy_policy(
            Some(&config),
            Uuid::new_v4(),
            Some(runtime_id),
            1_700_000_000,
        )
        .expect("denied policy");
        assert_eq!(denied, BrowserWebRtcProxyPolicy::Disabled);
        assert!(
            browser_webrtc_proxy_policy(Some(&config), project_id, None, 1_700_000_000,).is_err()
        );
    }

    #[test]
    fn origin_access_scope_allowlist_separates_browser_from_workspace_access() {
        for scope in ["fs.read", "fs.write", "browser.view", "browser.control"] {
            assert!(is_supported_origin_access_scope(scope), "scope: {scope}");
        }
        assert!(!is_supported_origin_access_scope("browser.admin"));
        assert!(!is_browser_origin_access_scope("fs.read"));
        assert!(is_browser_origin_access_scope("browser.view"));
        assert!(is_browser_origin_access_scope("browser.control"));
    }

    #[test]
    fn browser_origin_scopes_are_http_only_and_do_not_imply_a_workspace_lease() {
        let requested = vec![
            " browser.view ".to_string(),
            "browser.control".to_string(),
            "browser.view".to_string(),
        ];
        let normalized =
            normalize_origin_access_scopes("http", &requested).expect("valid browser scopes");
        assert_eq!(
            normalized,
            vec!["browser.control".to_string(), "browser.view".to_string()]
        );
        assert!(!normalized.iter().any(|scope| scope == "fs.write"));

        assert_eq!(
            normalize_origin_access_scopes("webdav", &requested),
            Err("browser scopes require the http protocol")
        );
        assert_eq!(
            normalize_origin_access_scopes("http", &["browser.admin".to_string()]),
            Err("unsupported scope requested")
        );
    }

    #[test]
    fn build_origin_jwks_returns_empty_when_missing() {
        let jwks = build_origin_jwks_from_pem(None, None, None).expect("jwks build");
        let keys = jwks
            .get("keys")
            .and_then(JsonValue::as_array)
            .expect("keys array");
        assert!(keys.is_empty());
    }

    #[test]
    fn origin_event_payload_serializes_without_presence() {
        let origin = WorkspaceOriginRecord {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            mode: OriginMode::Desktop,
            endpoint: "https://example-origin".to_string(),
            protocols: vec!["http".to_string(), "webdav".to_string()],
            region: Some("iad".to_string()),
            device_id: Some("device-123".to_string()),
            metadata: Some(json!({
                "deviceId": "device-123",
                "runtimeId": "runtime-abc"
            })),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let payload = origin_event_payload(&origin, None);
        let object = payload.as_object().expect("json object");

        assert_eq!(
            object
                .get("originId")
                .and_then(JsonValue::as_str)
                .expect("origin id"),
            origin.id.to_string()
        );
        assert_eq!(
            object
                .get("projectId")
                .and_then(JsonValue::as_str)
                .expect("project id"),
            origin.project_id.to_string()
        );
        assert_eq!(
            object.get("mode").and_then(JsonValue::as_str),
            Some("desktop")
        );
        assert_eq!(
            object.get("endpoint").and_then(JsonValue::as_str),
            Some("https://example-origin")
        );
        assert!(object.get("presence").is_some());
        assert!(object.get("presence").unwrap().is_null());
    }

    #[test]
    fn origin_event_payload_includes_presence_snapshot() {
        let now = Utc::now();
        let origin_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let origin = WorkspaceOriginRecord {
            id: origin_id,
            project_id,
            mode: OriginMode::Desktop,
            endpoint: "https://desktop-origin".to_string(),
            protocols: vec!["http".to_string()],
            region: None,
            device_id: Some("device-999".to_string()),
            metadata: None,
            created_at: now,
            updated_at: now,
        };

        let presence = OriginPresenceRecord {
            origin_id,
            project_id,
            status: OriginPresenceStatus::Online,
            last_heartbeat: now,
            latency_ms: Some(27),
            region: Some("iad".to_string()),
            metadata: Some(json!({"latencySampleCount": 3})),
            created_at: now,
            updated_at: now,
        };

        let payload = origin_event_payload(&origin, Some(&presence));
        let object = payload.as_object().expect("json object");
        let presence_value = object
            .get("presence")
            .and_then(JsonValue::as_object)
            .expect("presence object");

        assert_eq!(
            presence_value.get("status").and_then(JsonValue::as_str),
            Some("online")
        );
        assert_eq!(
            presence_value
                .get("latencyMs")
                .and_then(JsonValue::as_i64)
                .map(|value| value as i32),
            Some(27)
        );
        assert_eq!(
            presence_value.get("region").and_then(JsonValue::as_str),
            Some("iad")
        );
        assert_eq!(
            presence_value
                .get("metadata")
                .and_then(JsonValue::as_object),
            presence.metadata.as_ref().and_then(JsonValue::as_object)
        );
        assert_eq!(
            presence_value
                .get("lastHeartbeat")
                .and_then(JsonValue::as_str)
                .map(|value| value.parse::<DateTime<Utc>>().ok())
                .flatten(),
            Some(presence.last_heartbeat)
        );
    }

    #[test]
    fn origin_ed25519_private_key_signs_tokens() {
        let pem = generated_ed25519_pem();

        let encoding_key =
            EncodingKey::from_ed_pem(pem.private_pem.as_bytes()).expect("encode key from pem");
        let mut header = JwtHeader::new(Algorithm::EdDSA);
        header.kid = Some("test-kid".to_string());

        let iat = Utc::now();
        let exp = iat + ChronoDuration::seconds(600);
        let claims = AccessTokenClaims {
            aud: "origin".to_string(),
            sub: "user".to_string(),
            project_id: "project".to_string(),
            origin_id: Some("origin".to_string()),
            runtime_id: None,
            protocol: Some("webdav".to_string()),
            scopes: vec!["fs.read".to_string()],
            lease_id: None,
            runtime_generation: None,
            run_id: None,
            iat: iat.timestamp(),
            exp: exp.timestamp(),
            jti: "test-jti".to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        };

        let token = encode(&header, &claims, &encoding_key).expect("sign token");

        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.set_audience(&["origin"]);
        let decoded = decode::<AccessTokenClaims>(
            &token,
            &DecodingKey::from_ed_pem(pem.public_pem.as_bytes()).expect("decoding key"),
            &validation,
        )
        .expect("decode token");

        assert_eq!(decoded.claims.aud, claims.aud);
        assert_eq!(decoded.claims.sub, claims.sub);
        assert_eq!(decoded.claims.scopes, claims.scopes);
        assert_eq!(decoded.claims.origin_id.as_deref(), Some("origin"));
        assert_eq!(decoded.claims.protocol.as_deref(), Some("webdav"));
        assert_eq!(decoded.header.kid.as_deref(), header.kid.as_deref());
    }

    #[test]
    fn origin_endpoint_for_client_rewrites_rt_endpoints_using_forwarded_headers() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-origin-key",
        );

        let origin_id = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("controller.instafy.dev"),
        );
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));

        let rewritten = origin_endpoint_for_client(
            &config,
            &headers,
            &origin_id,
            "http://abc123.rt.instafy.dev/",
        );

        assert_eq!(
            rewritten,
            format!("https://controller.instafy.dev/origin/{origin_id}")
        );
    }

    #[test]
    fn origin_endpoint_for_client_rewrites_rt_test_endpoints_using_forwarded_headers() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-origin-key",
        );

        let origin_id = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("controller.instafy.dev"),
        );
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));

        let rewritten = origin_endpoint_for_client(
            &config,
            &headers,
            &origin_id,
            "http://abc123.rt.test:8443/",
        );

        assert_eq!(
            rewritten,
            format!("https://controller.instafy.dev/origin/{origin_id}")
        );
    }

    #[test]
    fn origin_endpoint_for_client_prefers_controller_external_url() {
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-origin-key",
        );
        config._controller_external_url = Some("https://controller.external.example".to_string());

        let origin_id = Uuid::new_v4();
        let headers = HeaderMap::new();

        let rewritten = origin_endpoint_for_client(
            &config,
            &headers,
            &origin_id,
            "http://abc123.rt.instafy.dev",
        );

        assert_eq!(
            rewritten,
            format!("https://controller.external.example/origin/{origin_id}")
        );
    }

    #[test]
    fn origin_endpoint_for_client_rewrites_local_gateway_endpoints() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-origin-key",
        );

        let origin_id = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("host.docker.internal:8788"),
        );

        let rewritten =
            origin_endpoint_for_client(&config, &headers, &origin_id, "http://127.0.0.1:54333/");

        assert_eq!(
            rewritten,
            format!("http://host.docker.internal:8788/origin/{origin_id}")
        );
    }

    #[test]
    fn origin_endpoint_for_client_rewrites_private_ipv4_endpoints() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-origin-key",
        );

        let origin_id = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("controller.instafy.dev"),
        );
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));

        let rewritten =
            origin_endpoint_for_client(&config, &headers, &origin_id, "http://10.99.0.80:63296");

        assert_eq!(
            rewritten,
            format!("https://controller.instafy.dev/origin/{origin_id}")
        );
    }

    #[test]
    fn origin_endpoint_for_client_does_not_rewrite_non_proxyable_endpoints() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-origin-key",
        );

        let origin_id = Uuid::new_v4();
        let headers = HeaderMap::new();

        assert_eq!(
            origin_endpoint_for_client(&config, &headers, &origin_id, "https://origin.example/"),
            "https://origin.example"
        );
        assert_eq!(
            origin_endpoint_for_client(&config, &headers, &origin_id, "http://localhost:1234"),
            "http://localhost:1234"
        );
        assert_eq!(
            origin_endpoint_for_client(&config, &headers, &origin_id, "http://example.com"),
            "http://example.com"
        );
    }

    #[test]
    fn private_ip_host_detection_matches_expected_ranges() {
        assert!(is_private_or_local_ip_host("10.99.0.80"));
        assert!(is_private_or_local_ip_host("172.18.5.10"));
        assert!(is_private_or_local_ip_host("192.168.0.12"));
        assert!(is_private_or_local_ip_host("100.100.10.10"));
        assert!(is_private_or_local_ip_host("127.0.0.1"));
        assert!(!is_private_or_local_ip_host("8.8.8.8"));
    }

    #[test]
    fn parse_default_gateway_ipv4_reads_linux_route_table() {
        let sample =
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n";

        assert_eq!(
            parse_default_gateway_ipv4(sample),
            Some(Ipv4Addr::new(172, 18, 0, 1))
        );
    }

    #[test]
    fn parse_default_gateway_ipv4_ignores_missing_default_route() {
        let sample =
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n";

        assert_eq!(parse_default_gateway_ipv4(sample), None);
    }
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceBeatBody {
    project_id: String,
    origin_id: String,
    status: Option<String>,
    latency_ms: Option<i32>,
    region: Option<String>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresenceBeatResponse {
    origin_id: Uuid,
    project_id: Uuid,
    status: String,
    last_heartbeat: String,
    latency_ms: Option<i32>,
    region: Option<String>,
    metadata: Option<JsonValue>,
    updated_at: String,
}

#[instrument(skip_all)]
#[allow(dead_code)]
async fn post_presence_beat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PresenceBeatBody>,
) -> Result<Json<PresenceBeatResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_optional_uuid_param(Some(body.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let origin_id = parse_optional_uuid_param(Some(body.origin_id), "originId")?
        .ok_or_else(|| bad_request("originId is required"))?;
    let claims =
        authorize_origin_request(&state, &headers, &project_id, &["origin.presence"]).await?;

    let status_str = body.status.unwrap_or_else(|| "online".to_string());
    let status = OriginPresenceStatus::from_str(status_str.to_lowercase().as_str())
        .map_err(|_| bad_request("invalid presence status"))?;
    authorize_registered_origin_identity(
        &state,
        &claims,
        &project_id,
        &origin_id,
        status == OriginPresenceStatus::Offline,
    )
    .await?;

    handle_presence_beat(
        &state,
        project_id,
        origin_id,
        status,
        body.latency_ms,
        body.region,
        body.metadata,
        claims,
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceBeatProjectBody {
    origin_id: String,
    status: Option<String>,
    latency_ms: Option<i32>,
    region: Option<String>,
    metadata: Option<JsonValue>,
}

#[instrument(skip_all)]
async fn post_presence_beat_project(
    State(state): State<AppState>,
    Path(params): Path<ProjectOriginPathParams>,
    headers: HeaderMap,
    Json(body): Json<PresenceBeatProjectBody>,
) -> Result<Json<PresenceBeatResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_optional_uuid_param(Some(params.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let origin_id = parse_optional_uuid_param(Some(body.origin_id), "originId")?
        .ok_or_else(|| bad_request("originId is required"))?;
    let claims =
        authorize_origin_request(&state, &headers, &project_id, &["origin.presence"]).await?;

    let status_str = body.status.unwrap_or_else(|| "online".to_string());
    let status = OriginPresenceStatus::from_str(status_str.to_lowercase().as_str())
        .map_err(|_| bad_request("invalid presence status"))?;
    authorize_registered_origin_identity(
        &state,
        &claims,
        &project_id,
        &origin_id,
        status == OriginPresenceStatus::Offline,
    )
    .await?;

    handle_presence_beat(
        &state,
        project_id,
        origin_id,
        status,
        body.latency_ms,
        body.region,
        body.metadata,
        claims,
    )
    .await
}

async fn handle_presence_beat(
    state: &AppState,
    project_id: Uuid,
    origin_id: Uuid,
    status: OriginPresenceStatus,
    latency_ms: Option<i32>,
    region: Option<String>,
    metadata: Option<JsonValue>,
    claims: AccessTokenClaims,
) -> Result<Json<PresenceBeatResponse>, (StatusCode, Json<ApiError>)> {
    let origin = load_origin_by_id(&state.pool, &origin_id)
        .await
        .map_err(|error| internal_error(format!("failed to load origin: {error}")))?;

    let Some(origin) = origin else {
        return Err(not_found("origin not registered"));
    };

    if origin.project_id != project_id {
        return Err(bad_request("origin/project mismatch"));
    }
    ensure_origin_mutation_binding(&state.pool, &claims, &project_id, &origin_id).await?;

    let presence = record_presence_heartbeat(
        &state.pool,
        &origin_id,
        &project_id,
        status,
        latency_ms,
        region.as_deref(),
        metadata.as_ref(),
    )
    .await
    .map_err(|error| internal_error(format!("failed to record presence: {error}")))?;

    publish_controller_event(
        &state.events,
        "origin.heartbeat",
        Some(project_id),
        None,
        None,
        None,
        origin_event_payload(&origin, Some(&presence)),
    );

    Ok(Json(PresenceBeatResponse {
        origin_id,
        project_id,
        status: presence.status.as_str().to_string(),
        last_heartbeat: presence.last_heartbeat.to_rfc3339(),
        latency_ms: presence.latency_ms,
        region: presence.region,
        metadata: presence.metadata,
        updated_at: presence.updated_at.to_rfc3339(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitReceiptBody {
    pub project_id: String,
    pub origin_id: String,
    pub lease_id: Option<String>,
    pub user_id: Option<String>,
    pub rev: String,
    pub bytes_written: Option<i64>,
    pub file_count: Option<i32>,
    pub duration_ms: Option<i32>,
    pub metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitReceiptResponse {
    pub receipt_id: Uuid,
    pub project_id: Uuid,
    pub origin_id: Uuid,
    pub lease_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
    pub rev: String,
    pub bytes_written: Option<i64>,
    pub file_count: Option<i32>,
    pub duration_ms: Option<i32>,
    pub created_at: String,
}

#[instrument(skip_all)]
pub(crate) async fn post_commit_receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CommitReceiptBody>,
) -> Result<Json<CommitReceiptResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_optional_uuid_param(Some(body.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let origin_id = parse_optional_uuid_param(Some(body.origin_id), "originId")?
        .ok_or_else(|| bad_request("originId is required"))?;
    let lease_id = parse_optional_uuid_param(body.lease_id.clone(), "leaseId")?;
    let user_id = parse_optional_uuid_param(body.user_id.clone(), "userId")?;
    let claims = authorize_origin_request(&state, &headers, &project_id, &["origin.apply"]).await?;

    if body.rev.trim().is_empty() {
        return Err(bad_request("rev is required"));
    }

    let origin = load_origin_by_id(&state.pool, &origin_id)
        .await
        .map_err(|error| internal_error(format!("failed to load origin: {error}")))?;
    let Some(origin) = origin else {
        return Err(not_found("origin not registered"));
    };
    if origin.project_id != project_id {
        return Err(bad_request("origin/project mismatch"));
    }
    ensure_origin_mutation_binding(&state.pool, &claims, &project_id, &origin_id).await?;

    let receipt = record_commit_receipt(
        &state.pool,
        &project_id,
        &origin_id,
        lease_id.as_ref(),
        user_id.as_ref(),
        body.rev.trim(),
        body.bytes_written,
        body.file_count,
        body.duration_ms,
        body.metadata.as_ref(),
    )
    .await
    .map_err(|error| internal_error(format!("failed to record commit receipt: {error}")))?;

    publish_controller_event(
        &state.events,
        "workspace.commit",
        Some(project_id),
        None,
        None,
        None,
        json!({
            "receiptId": receipt.id.to_string(),
            "originId": origin_id.to_string(),
            "originMode": origin.mode.as_str(),
            "originEndpoint": origin.endpoint,
            "leaseId": receipt.lease_id.map(|value| value.to_string()),
            "userId": receipt.user_id.map(|value| value.to_string()),
            "rev": receipt.rev,
            "bytesWritten": receipt.bytes_written,
            "fileCount": receipt.file_count,
            "durationMs": receipt.duration_ms,
            "createdAt": receipt.created_at.to_rfc3339(),
        }),
    );

    Ok(Json(CommitReceiptResponse {
        receipt_id: receipt.id,
        project_id,
        origin_id,
        lease_id: receipt.lease_id,
        user_id: receipt.user_id,
        rev: receipt.rev,
        bytes_written: receipt.bytes_written,
        file_count: receipt.file_count,
        duration_ms: receipt.duration_ms,
        created_at: receipt.created_at.to_rfc3339(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseAcquireBody {
    project_id: String,
    runtime_id: Option<String>,
    lease_seconds: Option<i64>,
    user_id: Option<String>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse {
    lease_id: Uuid,
    project_id: Uuid,
    user_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    status: String,
    acquired_at: String,
    expires_at: String,
    conflict: bool,
}

#[instrument(skip_all)]
/// Read-only view of the project's currently active workspace lease, so
/// origins can warn/serialize before pushing canonical syncs.
async fn get_project_lease(
    State(state): State<AppState>,
    Path(params): Path<ProjectOriginPathParams>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;
    let project_id = parse_optional_uuid_param(Some(params.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    if let Some(claims) = context.scoped_claims.as_ref() {
        let workspace_write_capability = claims.scopes.iter().any(|scope| scope == "fs.write");
        let workspace_read_capability = claims.scopes.iter().any(|scope| scope == "fs.read");
        if workspace_write_capability {
            // An fs.write bearer may outlive either its lease or the user's
            // builder role. Origins call this endpoint immediately before
            // mutation, so revalidate the exact lease binding and current
            // write authorization instead of treating a valid signature as
            // sufficient authority.
            authorize_workspace_origin_git_write(&state, &context, &project_id).await?;
        } else if workspace_read_capability {
            ensure_scoped_project_match(&context, &project_id)?;

            // Preserve normal missing/deleted-project handling without
            // treating the scoped token subject as a project member.
            let mut connection = state.pool.get().await.map_err(|error| {
                internal_error(format!("failed to acquire connection: {error}"))
            })?;
            let transaction = connection
                .transaction()
                .await
                .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
            load_project_record(&transaction, &project_id).await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finalize project lookup: {error}"))
            })?;
        } else {
            authorize_runtime_capability(
                &state,
                &context,
                &project_id,
                RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE,
            )
            .await?;
        }
    } else {
        load_and_authorize_project(&state, &project_id, &context).await?;
    }

    let mut lease = load_active_lease_for_project(&state.pool, &project_id)
        .await
        .map_err(|error| internal_error(format!("failed to load active lease: {error}")))?;

    if let Some(runtime_id) = lease.as_ref().and_then(|record| record.runtime_id) {
        let binding_is_visible = workspace_runtime_binding_is_visible(
            &state,
            &project_id,
            &runtime_id,
            context.user_id,
            context.is_service_role,
        )
        .await?;
        if !binding_is_visible {
            if let Some(record) = lease.as_mut() {
                record.runtime_id = None;
            }
        }
    }

    Ok(Json(serde_json::json!({
        "lease": lease.map(|record| serde_json::json!({
            "leaseId": record.id,
            "projectId": record.project_id,
            "userId": record.user_id,
            "runtimeId": record.runtime_id,
            "expiresAt": record.expires_at.to_rfc3339(),
        })),
    })))
}

async fn post_lease_acquire(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LeaseAcquireBody>,
) -> Result<Json<LeaseResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;

    let project_id = parse_optional_uuid_param(Some(body.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let runtime_id = parse_optional_uuid_param(body.runtime_id.clone(), "runtimeId")?;
    let explicit_user_id = parse_optional_uuid_param(body.user_id.clone(), "userId")?;

    let job_capability = if context.scoped_claims.is_some() {
        Some(
            authorize_active_job_capability(
                &state,
                &context,
                &project_id,
                JOB_WORKSPACE_LEASE_WRITE_SCOPE,
            )
            .await?,
        )
    } else {
        None
    };

    let actor_user =
        if let Some(job) = job_capability.as_ref() {
            if runtime_id != Some(job.runtime_id) {
                return Err(unauthorized(
                    "workspace lease runtime does not match the active job",
                ));
            }
            if explicit_user_id.is_some_and(|user_id| user_id != job.subject_user) {
                return Err(unauthorized(
                    "workspace lease user does not match the active job",
                ));
            }
            ensure_job_lease_metadata(body.metadata.as_ref(), job)?;
            Some(job.subject_user)
        } else if let Some(user) = context.user_id {
            Some(user)
        } else if context.is_service_role {
            Some(explicit_user_id.ok_or_else(|| {
                bad_request("userId is required for service role lease acquisition")
            })?)
        } else {
            return Err(unauthorized("authentication required to acquire lease"));
        };

    if job_capability.is_none() {
        load_and_authorize_project_write(&state, &project_id, &context, &["fs.write"]).await?;
    }

    if let Some(runtime_id) = runtime_id.as_ref() {
        ensure_workspace_runtime_binding_access(
            &state,
            &project_id,
            runtime_id,
            actor_user,
            context.is_service_role,
        )
        .await?;
    }

    let lease_seconds = if job_capability.is_some() {
        body.lease_seconds.unwrap_or(90).min(120)
    } else {
        body.lease_seconds.unwrap_or(90)
    };

    let outcome = acquire_lease(
        &state.pool,
        &project_id,
        actor_user.as_ref(),
        runtime_id.as_ref(),
        lease_seconds,
        body.metadata.as_ref(),
    )
    .await
    .map_err(|error| internal_error(format!("failed to acquire lease: {error}")))?;

    match outcome {
        LeaseAcquireOutcome::Granted(lease) | LeaseAcquireOutcome::Renewed(lease) => {
            Ok(Json(LeaseResponse {
                lease_id: lease.id,
                project_id: lease.project_id,
                user_id: lease.user_id,
                runtime_id: lease.runtime_id,
                status: lease.status,
                acquired_at: lease.acquired_at.to_rfc3339(),
                expires_at: lease.expires_at.to_rfc3339(),
                conflict: false,
            }))
        }
        LeaseAcquireOutcome::Conflict { holder } => Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(format!(
                "project currently leased by {} until {}",
                holder
                    .user_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "unknown actor".to_string()),
                holder.expires_at.to_rfc3339(),
            ))),
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRenewBody {
    lease_id: String,
    project_id: String,
    runtime_id: Option<String>,
    lease_seconds: Option<i64>,
    metadata: Option<JsonValue>,
}

#[instrument(skip_all)]
async fn post_lease_renew(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LeaseRenewBody>,
) -> Result<Json<LeaseResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;
    let lease_id = parse_optional_uuid_param(Some(body.lease_id), "leaseId")?
        .ok_or_else(|| bad_request("leaseId is required"))?;
    let project_id = parse_optional_uuid_param(Some(body.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let runtime_id = parse_optional_uuid_param(body.runtime_id.clone(), "runtimeId")?;

    let job_capability = if context.scoped_claims.is_some() {
        Some(
            authorize_active_job_capability(
                &state,
                &context,
                &project_id,
                JOB_WORKSPACE_LEASE_WRITE_SCOPE,
            )
            .await?,
        )
    } else {
        None
    };
    let actor_user = if let Some(job) = job_capability.as_ref() {
        if runtime_id != Some(job.runtime_id) {
            return Err(unauthorized(
                "workspace lease runtime does not match the active job",
            ));
        }
        ensure_job_lease_metadata(body.metadata.as_ref(), job)?;
        job.subject_user
    } else {
        context
            .user_id
            .ok_or_else(|| unauthorized("authentication required to renew a workspace lease"))?
    };

    if job_capability.is_none() {
        load_and_authorize_project_write(&state, &project_id, &context, &["fs.write"]).await?;
    }

    let lease = load_active_lease_by_id(&state.pool, &lease_id)
        .await
        .map_err(|error| internal_error(format!("failed to load lease: {error}")))?
        .ok_or_else(|| not_found("lease not found or no longer active"))?;
    if lease.project_id != project_id {
        return Err(unauthorized(
            "workspace lease project does not match the request",
        ));
    }
    if runtime_id.is_some() && runtime_id != lease.runtime_id {
        return Err(unauthorized(
            "workspace lease runtime does not match the active lease",
        ));
    }
    if let Some(job) = job_capability.as_ref() {
        ensure_workspace_lease_matches_job(&lease, job)?;
    }
    if let Some(lease_runtime_id) = lease.runtime_id.as_ref() {
        ensure_workspace_runtime_binding_access(
            &state,
            &project_id,
            lease_runtime_id,
            Some(actor_user),
            context.is_service_role,
        )
        .await?;
    }

    let lease_seconds = if job_capability.is_some() {
        body.lease_seconds.unwrap_or(90).min(120)
    } else {
        body.lease_seconds.unwrap_or(90)
    };

    let updated = renew_lease(
        &state.pool,
        &lease_id,
        &project_id,
        Some(&actor_user),
        lease.runtime_id.as_ref(),
        lease_seconds,
        body.metadata.as_ref(),
    )
    .await
    .map_err(|error| internal_error(format!("failed to renew lease: {error}")))?;

    let Some(lease) = updated else {
        return Err(not_found("lease not found or no longer active"));
    };

    Ok(Json(LeaseResponse {
        lease_id: lease.id,
        project_id: lease.project_id,
        user_id: lease.user_id,
        runtime_id: lease.runtime_id,
        status: lease.status,
        acquired_at: lease.acquired_at.to_rfc3339(),
        expires_at: lease.expires_at.to_rfc3339(),
        conflict: false,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseReleaseBody {
    lease_id: String,
    project_id: String,
    runtime_id: Option<String>,
    status: Option<String>,
}

#[instrument(skip_all)]
async fn post_lease_release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LeaseReleaseBody>,
) -> Result<Json<LeaseResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;

    let lease_id = parse_optional_uuid_param(Some(body.lease_id), "leaseId")?
        .ok_or_else(|| bad_request("leaseId is required"))?;
    let project_id = parse_optional_uuid_param(Some(body.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let runtime_id = parse_optional_uuid_param(body.runtime_id.clone(), "runtimeId")?;

    let job_capability = if context.scoped_claims.is_some() {
        Some(
            authorize_active_job_capability(
                &state,
                &context,
                &project_id,
                JOB_WORKSPACE_LEASE_WRITE_SCOPE,
            )
            .await?,
        )
    } else {
        None
    };

    let actor_user = if let Some(job) = job_capability.as_ref() {
        if runtime_id != Some(job.runtime_id) {
            return Err(unauthorized(
                "workspace lease runtime does not match the active job",
            ));
        }
        Some(job.subject_user)
    } else {
        let actor_user = context
            .user_id
            .or_else(|| if context.is_service_role { None } else { None });
        if actor_user.is_none() && !context.is_service_role {
            return Err(unauthorized(
                "authentication required to release a workspace lease",
            ));
        }
        load_and_authorize_project_write(&state, &project_id, &context, &["fs.write"]).await?;
        actor_user
    };

    let lease = load_active_lease_by_id(&state.pool, &lease_id)
        .await
        .map_err(|error| internal_error(format!("failed to load lease: {error}")))?
        .ok_or_else(|| not_found("lease not found or no longer active"))?;
    if lease.project_id != project_id {
        return Err(unauthorized(
            "workspace lease project does not match the request",
        ));
    }
    if runtime_id.is_some() && runtime_id != lease.runtime_id {
        return Err(unauthorized(
            "workspace lease runtime does not match the active lease",
        ));
    }
    if let Some(job) = job_capability.as_ref() {
        ensure_workspace_lease_matches_job(&lease, job)?;
    }
    if let Some(lease_runtime_id) = lease.runtime_id.as_ref() {
        ensure_workspace_runtime_binding_access(
            &state,
            &project_id,
            lease_runtime_id,
            actor_user,
            context.is_service_role,
        )
        .await?;
    }

    let status = body
        .status
        .unwrap_or_else(|| "released".to_string())
        .to_lowercase();
    if status != "released" && status != "revoked" {
        return Err(bad_request("status must be 'released' or 'revoked'"));
    }
    if job_capability.is_some() && status != "released" {
        return Err(forbidden("job tokens may only release workspace leases"));
    }

    let released = release_lease(
        &state.pool,
        &lease_id,
        &project_id,
        actor_user.as_ref(),
        lease.runtime_id.as_ref(),
        &status,
    )
    .await
    .map_err(|error| internal_error(format!("failed to release lease: {error}")))?;

    let Some(lease) = released else {
        return Err(not_found("lease not found"));
    };

    Ok(Json(LeaseResponse {
        lease_id: lease.id,
        project_id: lease.project_id,
        user_id: lease.user_id,
        runtime_id: lease.runtime_id,
        status: lease.status,
        acquired_at: lease.acquired_at.to_rfc3339(),
        expires_at: lease.expires_at.to_rfc3339(),
        conflict: false,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessTokenRequest {
    pub project_id: String,
    pub protocol: Option<String>,
    pub scopes: Vec<String>,
    pub origin_id: Option<String>,
    pub prefer_hosted: Option<bool>,
    pub prefer_runtime: Option<String>,
    pub lease_id: Option<String>,
    pub browser_session_id: Option<String>,
}

const BROWSER_SESSION_ID_MAX_BYTES: usize = 128;
const BROWSER_ACTOR_LABEL_MAX_BYTES: usize = 64;

fn normalize_browser_session_id(
    value: Option<&str>,
    browser_access_requested: bool,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let normalized = value.map(str::trim).filter(|value| !value.is_empty());
    if !browser_access_requested {
        if normalized.is_some() {
            return Err(bad_request(
                "browserSessionId is only valid for browser scopes",
            ));
        }
        return Ok(None);
    }
    let value =
        normalized.ok_or_else(|| bad_request("browserSessionId is required for browser scopes"))?;
    if value.len() > BROWSER_SESSION_ID_MAX_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(bad_request("browserSessionId is invalid"));
    }
    Ok(Some(value.to_string()))
}

fn truncate_browser_actor_label(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.len() <= BROWSER_ACTOR_LABEL_MAX_BYTES {
        return normalized;
    }
    let mut end = BROWSER_ACTOR_LABEL_MAX_BYTES.min(normalized.len());
    while end > 0 && !normalized.is_char_boundary(end) {
        end -= 1;
    }
    normalized[..end].trim().to_string()
}

async fn load_browser_actor_label(
    state: &AppState,
    user_id: &Uuid,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!(
            "failed to acquire browser actor connection: {error}"
        ))
    })?;
    let row = connection
        .query_opt(
            "select coalesce(
                 nullif(btrim(p.full_name), ''),
                 nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                 nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                 nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''),
                 nullif(split_part(coalesce(u.email, ''), '@', 1), '')
               ) as actor_label
             from auth.users u
             left join profiles p on p.user_id = u.id
             where u.id = $1
             limit 1",
            &[user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load browser actor label: {error}")))?;
    let label = row
        .and_then(|row| row.get::<_, Option<String>>("actor_label"))
        .map(|value| truncate_browser_actor_label(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Teammate".to_string());
    Ok(label)
}

fn is_supported_origin_access_scope(scope: &str) -> bool {
    matches!(
        scope,
        "fs.read" | "fs.write" | "browser.view" | "browser.control"
    )
}

fn is_browser_origin_access_scope(scope: &str) -> bool {
    matches!(scope, "browser.view" | "browser.control")
}

fn normalize_origin_access_scopes(
    protocol: &str,
    requested_scopes: &[String],
) -> Result<Vec<String>, &'static str> {
    let mut scopes: Vec<String> = requested_scopes
        .iter()
        .map(|scope| scope.trim().to_lowercase())
        .filter(|scope| !scope.is_empty())
        .collect();
    scopes.sort();
    scopes.dedup();

    if scopes.is_empty() {
        return Err("scopes are required");
    }
    if scopes
        .iter()
        .any(|scope| !is_supported_origin_access_scope(scope))
    {
        return Err("unsupported scope requested");
    }
    if protocol != "http"
        && scopes
            .iter()
            .any(|scope| is_browser_origin_access_scope(scope))
    {
        return Err("browser scopes require the http protocol");
    }
    Ok(scopes)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessTokenResponse {
    origin_id: Uuid,
    mode: String,
    endpoint: String,
    token: String,
    expires_in: i64,
    scopes: Vec<String>,
    lease_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct GitAccessTokenPathParams {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitAccessTokenRequest {
    scopes: Vec<String>,
    ttl_seconds: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitAccessTokenResponse {
    project_id: Uuid,
    token: String,
    expires_in: i64,
    scopes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitShardRouteResponse {
    project_id: Uuid,
    repo: String,
    shard_url: String,
}

#[instrument(skip_all)]
async fn post_git_access_token(
    State(state): State<AppState>,
    Path(params): Path<GitAccessTokenPathParams>,
    headers: HeaderMap,
    Json(body): Json<GitAccessTokenRequest>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;

    let project_id = parse_optional_uuid_param(Some(params.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;

    if body.scopes.is_empty() {
        return Err(bad_request("scopes are required"));
    }

    let mut normalized_scopes: Vec<String> = body
        .scopes
        .iter()
        .map(|scope| scope.trim().to_lowercase())
        .filter(|scope| !scope.is_empty())
        .collect();
    normalized_scopes.sort();
    normalized_scopes.dedup();

    if normalized_scopes.is_empty() {
        return Err(bad_request("scopes are required"));
    }

    for scope in &normalized_scopes {
        if scope != "git.read" && scope != "git.write" {
            return Err(bad_request("unsupported scope requested"));
        }
    }

    let scoped_capability = if let Some(claims) = context.scoped_claims.as_ref() {
        let legacy_job_token = claims
            .scopes
            .iter()
            .any(|scope| scope == LEGACY_JOB_EXECUTE_SCOPE)
            && !claims
                .scopes
                .iter()
                .any(|scope| scope == JOB_TOKEN_SEPARATED_SCOPE);
        let job_git_capability = claims
            .scopes
            .iter()
            .any(|scope| scope == JOB_GIT_TOKEN_MINT_SCOPE)
            || legacy_job_token;
        let workspace_origin_capability = claims.scopes.iter().any(|scope| scope == "fs.write")
            && claims.origin_id.is_some()
            && matches!(claims.protocol.as_deref(), Some("http" | "webdav"));
        if workspace_origin_capability {
            // Origin servers use their request's fs.write credential to push
            // the exact files they just applied. Validate the workspace lease
            // independently here because callers can reach this endpoint
            // without traversing the origin middleware.
            let workspace =
                authorize_workspace_origin_git_write(&state, &context, &project_id).await?;
            Some(ScopedGitMintContext {
                subject: workspace.subject_user.to_string(),
                runtime_id: workspace.runtime_id,
                lease_id: Some(workspace.lease_id),
                run_id: workspace.run_id,
                latest_expires_at: Some(workspace.expires_at),
            })
        } else if job_git_capability {
            let job = authorize_active_job_capability(
                &state,
                &context,
                &project_id,
                JOB_GIT_TOKEN_MINT_SCOPE,
            )
            .await?;
            if !git_scopes_are_read_only(&normalized_scopes) {
                return Err(forbidden(
                    "job tokens may only mint git.read; workspace writes require an active origin lease",
                ));
            }
            Some(ScopedGitMintContext {
                subject: job.subject_user.to_string(),
                runtime_id: Some(job.runtime_id),
                lease_id: job.runtime_lease_id,
                run_id: Some(job.run_id),
                latest_expires_at: None,
            })
        } else {
            // A runtime machine token identifies a live runtime generation,
            // not a user-authorized workspace write. It can bootstrap/fetch
            // canonical Git, but writes must use the fs.write origin path
            // above, which is bound to an active workspace lease. This keeps
            // a leaked machine token read-only even when a viewer or read-only
            // job is currently using the runtime.
            if !git_scopes_are_read_only(&normalized_scopes) {
                return Err(forbidden(
                    "runtime machine tokens may only mint git.read access",
                ));
            }
            let runtime = authorize_runtime_capability(
                &state,
                &context,
                &project_id,
                RUNTIME_TOKEN_GIT_MINT_SCOPE,
            )
            .await?;
            Some(ScopedGitMintContext {
                subject: runtime.subject,
                runtime_id: Some(runtime.runtime_id),
                lease_id: runtime.lease_id,
                run_id: None,
                latest_expires_at: None,
            })
        }
    } else {
        if normalized_scopes.iter().any(|scope| scope == "git.write") {
            load_and_authorize_project_write(&state, &project_id, &context, &["git.write"]).await?;
        } else {
            load_and_authorize_project(&state, &project_id, &context).await?;
        }
        None
    };

    if state.config.origin_token_private_key.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("token signing key not configured")),
        ));
    }

    let actor_user = context.user_id;
    let service_role_subject_user =
        if scoped_capability.is_none() && context.is_service_role && actor_user.is_none() {
            resolve_service_role_subject_user(&state).await?
        } else {
            None
        };
    let subject = if let Some(capability) = scoped_capability.as_ref() {
        Some(capability.subject.clone())
    } else if let Some(user) = actor_user {
        Some(user.to_string())
    } else if context.is_service_role {
        service_role_subject_user.map(|user| user.to_string())
    } else {
        None
    };

    let Some(subject) = subject else {
        return Err(unauthorized(
            "authentication required to mint git access tokens",
        ));
    };

    // Git tokens are short-lived by design (callers typically request 600s);
    // cap the requested TTL so a leaked token cannot hold git.write for long.
    const MAX_GIT_TOKEN_TTL_SECONDS: i64 = 3600;
    let mut ttl_seconds = body
        .ttl_seconds
        .unwrap_or(state.config.origin_token_ttl_seconds)
        .min(MAX_GIT_TOKEN_TTL_SECONDS);
    let latest_expires_at = scoped_capability
        .as_ref()
        .and_then(|capability| capability.latest_expires_at);
    if latest_expires_at.is_some() {
        ttl_seconds = ttl_seconds.min(60);
    }
    let ttl_seconds = Some(ttl_seconds.max(1));

    let token_request = ScopedTokenRequest {
        audience: "git".to_string(),
        subject,
        project_id: project_id.to_string(),
        origin_id: None,
        runtime_id: scoped_capability
            .as_ref()
            .and_then(|capability| capability.runtime_id.map(|value| value.to_string())),
        protocol: Some("git".to_string()),
        scopes: normalized_scopes.clone(),
        lease_id: scoped_capability
            .as_ref()
            .and_then(|capability| capability.lease_id.map(|value| value.to_string())),
        run_id: scoped_capability
            .as_ref()
            .and_then(|capability| capability.run_id.map(|value| value.to_string())),
        prefer_runtime: None,
        ttl_seconds,
    };
    let minted = if let Some(latest_expires_at) = latest_expires_at {
        mint_scoped_token_expires_no_later_than(&state.config, token_request, latest_expires_at)?
    } else {
        mint_scoped_token(&state.config, token_request)?
    };

    let response = GitAccessTokenResponse {
        project_id,
        token: minted.token,
        expires_in: minted.ttl,
        scopes: normalized_scopes,
    };

    let value = serde_json::to_value(response).map_err(|error| {
        internal_error(format!("failed to serialize git access token: {error}"))
    })?;

    Ok(Json(value))
}

#[instrument(skip_all)]
async fn get_git_shard_route(
    State(state): State<AppState>,
    Path(params): Path<GitAccessTokenPathParams>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;
    if !context.is_service_role {
        return Err(forbidden("service authentication required"));
    }

    let project_id = parse_optional_uuid_param(Some(params.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;

    load_and_authorize_project(&state, &project_id, &context).await?;

    if state.config.git_shards.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("git shards are not configured")),
        ));
    }

    let shard_url =
        resolve_or_assign_git_repo_shard(&state.pool, &project_id, &state.config.git_shards)
            .await
            .map_err(|error| internal_error(format!("failed to resolve git shard: {error}")))?;

    let response = GitShardRouteResponse {
        project_id,
        repo: format!("{}.git", project_id),
        shard_url,
    };

    let value = serde_json::to_value(response)
        .map_err(|error| internal_error(format!("failed to serialize git shard route: {error}")))?;

    Ok(Json(value))
}

async fn resolve_or_assign_git_repo_shard(
    pool: &PgPool,
    project_id: &Uuid,
    shards: &[String],
) -> Result<String> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for git shard routing")?;

    if let Some(row) = connection
        .query_opt(
            "select shard_url from git_repo_locations where project_id = $1",
            &[project_id],
        )
        .await
        .context("failed to query git repo locations")?
    {
        return Ok(row.get::<_, String>("shard_url"));
    }

    let shard_url = pick_git_shard(project_id, shards)
        .cloned()
        .ok_or_else(|| anyhow!("no git shards available"))?;

    // Race-safe insert: if another requester won, fall back to select.
    let inserted = connection
        .query_opt(
            "insert into git_repo_locations (project_id, shard_url)
             values ($1, $2)
             on conflict (project_id) do nothing
             returning shard_url",
            &[project_id, &shard_url],
        )
        .await
        .context("failed to insert git repo location")?;

    if let Some(row) = inserted {
        return Ok(row.get::<_, String>("shard_url"));
    }

    let row = connection
        .query_one(
            "select shard_url from git_repo_locations where project_id = $1",
            &[project_id],
        )
        .await
        .context("failed to re-read git repo location after conflict")?;
    Ok(row.get::<_, String>("shard_url"))
}

fn pick_git_shard<'a>(project_id: &Uuid, shards: &'a [String]) -> Option<&'a String> {
    if shards.is_empty() {
        return None;
    }
    let key = project_id.to_string();
    let idx = (fnv1a_64(key.as_bytes()) % shards.len() as u64) as usize;
    shards.get(idx)
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x00000100000001B3);
    }
    hash
}

#[instrument(skip_all)]
pub(crate) async fn post_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AccessTokenRequest>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;

    let project_id = parse_optional_uuid_param(Some(body.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;

    let protocol = body
        .protocol
        .unwrap_or_else(|| "webdav".to_string())
        .to_lowercase();
    if protocol != "webdav" && protocol != "http" && protocol != "smb" {
        return Err(bad_request("protocol must be webdav, http, or smb"));
    }

    if protocol == "smb" {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(ApiError::new("SMB access tokens are not available yet")),
        ));
    }

    let normalized_scopes =
        normalize_origin_access_scopes(&protocol, &body.scopes).map_err(bad_request)?;
    let browser_access_requested = normalized_scopes
        .iter()
        .any(|scope| is_browser_origin_access_scope(scope));

    let job_capability = if context.scoped_claims.is_some() {
        if protocol != "http" || normalized_scopes.as_slice() != ["fs.write"] {
            return Err(forbidden(
                "job tokens may only mint HTTP workspace-write access",
            ));
        }
        if body.origin_id.is_some() || body.prefer_hosted == Some(true) {
            return Err(forbidden(
                "job tokens cannot override workspace origin selection",
            ));
        }
        Some(
            authorize_active_job_capability(
                &state,
                &context,
                &project_id,
                JOB_ORIGIN_TOKEN_MINT_SCOPE,
            )
            .await?,
        )
    } else {
        None
    };

    let write_access_required = normalized_scopes
        .iter()
        .any(|scope| scope == "fs.write" || scope == "browser.control");
    if job_capability.is_none() {
        if write_access_required {
            load_and_authorize_project_write(&state, &project_id, &context, &["fs.write"]).await?;
        } else {
            load_and_authorize_project(&state, &project_id, &context).await?;
        }
    }

    let lease_required = normalized_scopes.iter().any(|scope| scope == "fs.write");
    let lease_id = parse_optional_uuid_param(body.lease_id.clone(), "leaseId")?;
    if lease_required && lease_id.is_none() {
        return Err(bad_request("leaseId required for write scopes"));
    }

    let lease_record = if let Some(lease_uuid) = lease_id {
        let lease = load_active_lease_by_id(&state.pool, &lease_uuid)
            .await
            .map_err(|error| internal_error(format!("failed to load lease: {error}")))?;
        let Some(lease) = lease else {
            return Err(not_found("lease not found or expired"));
        };
        if lease.project_id != project_id {
            return Err(bad_request("lease does not belong to project"));
        }
        if let Some(job) = job_capability.as_ref() {
            ensure_workspace_lease_matches_job(&lease, job)?;
        }
        Some(lease)
    } else {
        None
    };

    if lease_required {
        let lease = lease_record
            .as_ref()
            .expect("lease required implies record present");
        if lease.status != "active" {
            return Err(bad_request("lease is no longer active"));
        }
        if lease.expires_at <= Utc::now() {
            return Err(bad_request("lease has expired"));
        }
    }

    let actor_user = context.user_id;
    let lease_user = lease_record.as_ref().and_then(|lease| lease.user_id);
    let service_role_subject_user = if context.is_service_role && actor_user.is_none() {
        resolve_service_role_subject_user(&state).await?
    } else {
        None
    };
    let subject_user = if let Some(user) = actor_user {
        if lease_required {
            let lease = lease_record
                .as_ref()
                .expect("lease required implies record present");
            if lease.user_id != Some(user) {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(ApiError::new("lease is held by a different user")),
                ));
            }
        }
        Some(user)
    } else if context.is_service_role {
        lease_user.or(service_role_subject_user)
    } else {
        None
    };
    let Some(subject_user) = subject_user else {
        return Err(unauthorized(
            "authentication required to mint origin access tokens",
        ));
    };

    if !context.is_service_role && actor_user.is_none() {
        return Err(unauthorized(
            "authentication required to mint origin access tokens",
        ));
    }

    if !context.is_service_role && lease_required {
        let lease = lease_record
            .as_ref()
            .expect("lease required implies record present");
        if lease.user_id != Some(subject_user) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError::new("lease is held by a different user")),
            ));
        }
    }

    let requested_origin_id = parse_optional_uuid_param(body.origin_id.clone(), "originId")?;
    let prefer_hosted = body.prefer_hosted.unwrap_or(false);
    let requested_preferred_runtime_id =
        parse_optional_uuid_param(body.prefer_runtime.clone(), "preferRuntime")?;
    if let Some(job) = job_capability.as_ref() {
        if requested_preferred_runtime_id.is_some_and(|runtime_id| runtime_id != job.runtime_id) {
            return Err(forbidden("preferred runtime does not match the active job"));
        }
    }
    let preferred_runtime_id = job_capability
        .as_ref()
        .map(|job| job.runtime_id)
        .or(requested_preferred_runtime_id);
    if let Some(runtime_uuid) = preferred_runtime_id {
        let runtime = runtime_provider_for_project(&state.pool, &project_id, &runtime_uuid)
            .await
            .map_err(|error| {
                internal_error(format!("failed to validate preferred runtime: {error}"))
            })?;
        let Some((runtime_provider, runtime_capabilities)) = runtime else {
            return Err(bad_request("preferred runtime does not belong to project"));
        };
        if job_capability.is_none() {
            crate::runtime::ensure_self_hosted_runtime_access(
                &state,
                &runtime_provider,
                &runtime_capabilities,
                context.user_id,
                context.is_service_role,
            )?;
        }
        if browser_access_requested
            && (!crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(
                &runtime_provider,
            ) || crate::runtime::runtime_is_private_self_hosted(
                &state,
                &runtime_provider,
                &runtime_capabilities,
            ))
        {
            return Err(forbidden(
                "Shared Browser is available only on managed Instafy Cloud runtimes",
            ));
        }
    }

    let browser_session_id =
        normalize_browser_session_id(body.browser_session_id.as_deref(), browser_access_requested)?;
    if browser_access_requested && prefer_hosted {
        return Err(bad_request(
            "preferHosted cannot be used with browser scopes",
        ));
    }

    let (origin, required_origin_runtime_id) = if browser_access_requested {
        let runtime_uuid = preferred_runtime_id
            .ok_or_else(|| bad_request("preferRuntime is required for browser scopes"))?;
        let resolved =
            resolve_origin_for_runtime_protocol(&state.pool, &project_id, &runtime_uuid, &protocol)
                .await
                .map_err(|error| {
                    internal_error(format!("failed to resolve browser runtime origin: {error}"))
                })?;
        let Some(resolved) = resolved else {
            return Err(not_found(
                "no online origin available for requested browser runtime",
            ));
        };
        if requested_origin_id.is_some_and(|origin_id| origin_id != resolved.origin.id) {
            return Err(bad_request(
                "origin is not the online origin for preferred runtime",
            ));
        }
        (resolved.origin, Some(runtime_uuid))
    } else if let Some(origin_uuid) = requested_origin_id {
        let origin = load_origin_by_id(&state.pool, &origin_uuid)
            .await
            .map_err(|error| internal_error(format!("failed to load origin: {error}")))?;
        let Some(origin) = origin else {
            return Err(not_found("origin not registered"));
        };
        if origin.project_id != project_id {
            return Err(bad_request("origin/project mismatch"));
        }
        if !origin.protocols.is_empty() && !origin.protocols.iter().any(|p| p == &protocol) {
            return Err(bad_request("origin does not support requested protocol"));
        }
        (origin, preferred_runtime_id)
    } else if prefer_hosted {
        let resolved = resolve_hosted_origin_for_protocol(&state, &project_id, &protocol)
            .await
            .map_err(|error| internal_error(format!("failed to resolve hosted origin: {error}")))?;
        let Some(resolved) = resolved else {
            return Err(not_found(
                "no hosted origin available for requested protocol",
            ));
        };
        (resolved.origin, None)
    } else if let Some(runtime_uuid) = preferred_runtime_id {
        if let Some(resolved) =
            resolve_origin_for_runtime_protocol(&state.pool, &project_id, &runtime_uuid, &protocol)
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to resolve preferred runtime origin: {error}"
                    ))
                })?
        {
            (resolved.origin, Some(runtime_uuid))
        } else if job_capability.is_some() {
            return Err(not_found(
                "no online origin available for the active job runtime",
            ));
        } else {
            let resolved = resolve_accessible_origin_for_protocol_with_hosted_fallback(
                &state,
                &project_id,
                &protocol,
                subject_user,
                context.is_service_role,
            )
            .await?;
            let Some(resolved) = resolved else {
                return Err(not_found("no origin available for requested protocol"));
            };
            (resolved.origin, None)
        }
    } else {
        let resolved = resolve_accessible_origin_for_protocol_with_hosted_fallback(
            &state,
            &project_id,
            &protocol,
            subject_user,
            context.is_service_role,
        )
        .await?;
        let Some(resolved) = resolved else {
            return Err(not_found("no origin available for requested protocol"));
        };
        (resolved.origin, None)
    };

    let origin_runtime_binding = origin_runtime_binding_for_subject(
        &state,
        &origin,
        required_origin_runtime_id,
        subject_user,
        context.is_service_role,
    )
    .await?;

    if lease_required {
        if let (Some(lease), Some(binding)) =
            (lease_record.as_ref(), origin_runtime_binding.as_ref())
        {
            let bound = bind_workspace_lease_runtime(
                &state.pool,
                &lease.id,
                &project_id,
                &subject_user,
                &binding.runtime_id,
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to bind origin workspace lease: {error}"))
            })?;
            if bound.is_none() {
                return Err(unauthorized(
                    "workspace lease cannot be bound to the selected origin runtime",
                ));
            }
        }
    }
    if browser_access_requested
        && origin_runtime_binding.as_ref().is_none_or(|binding| {
            !crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(&binding.provider)
                || crate::runtime::runtime_is_private_self_hosted(
                    &state,
                    &binding.provider,
                    &binding.capabilities,
                )
        })
    {
        return Err(forbidden(
            "Shared Browser is available only on managed Instafy Cloud runtimes",
        ));
    }

    if state.config.origin_token_private_key.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("origin token signing key not configured")),
        ));
    }

    let lease_id_value = lease_record.as_ref().map(|lease| lease.id);
    let validated_runtime_claim = origin_runtime_binding
        .as_ref()
        .map(|binding| binding.runtime_id.to_string());
    let validated_runtime_generation = origin_runtime_binding
        .as_ref()
        .filter(|binding| {
            crate::runtime::runtime_is_private_self_hosted(
                &state,
                &binding.provider,
                &binding.capabilities,
            )
        })
        .map(|binding| crate::runtime::runtime_generation_from_capabilities(&binding.capabilities))
        .transpose()?
        .flatten();
    let validated_run_claim = job_capability.as_ref().map(|job| job.run_id.to_string());
    let browser_actor_label = if browser_access_requested {
        Some(load_browser_actor_label(&state, &subject_user).await?)
    } else {
        None
    };

    let scoped_token = mint_scoped_token_with_browser_actor(
        &state.config,
        ScopedTokenRequest {
            audience: origin.id.to_string(),
            subject: subject_user.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin.id.to_string()),
            runtime_id: validated_runtime_claim.clone(),
            protocol: Some(protocol.clone()),
            scopes: normalized_scopes.clone(),
            lease_id: lease_id_value.map(|value| value.to_string()),
            run_id: validated_run_claim,
            prefer_runtime: validated_runtime_claim,
            ttl_seconds: None,
        },
        validated_runtime_generation,
        browser_actor_label,
        browser_session_id,
    )?;

    record_access_grant(
        &state.pool,
        &project_id,
        &origin.id,
        Some(&subject_user),
        lease_id_value.as_ref(),
        &normalized_scopes,
        &protocol,
        scoped_token.issued_at,
        scoped_token.expires_at,
        Some(&scoped_token.jti),
        None,
        None,
    )
    .await
    .map_err(|error| internal_error(format!("failed to record access grant: {error}")))?;

    let endpoint =
        origin_endpoint_for_client(&state.config, &headers, &origin.id, &origin.endpoint);

    let response = AccessTokenResponse {
        origin_id: origin.id,
        mode: origin.mode.as_str().to_string(),
        endpoint,
        token: scoped_token.token,
        expires_in: scoped_token.ttl,
        scopes: normalized_scopes,
        lease_id: lease_id_value,
    };

    let response_value = serde_json::to_value(response)
        .map_err(|error| internal_error(format!("failed to serialize access token: {error}")))?;

    Ok(Json(response_value))
}

async fn load_and_authorize_project(
    state: &AppState,
    project_id: &Uuid,
    context: &RequestContext,
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    load_and_authorize_project_with_scopes(state, project_id, context, None).await
}

async fn load_and_authorize_project_for_write(
    state: &AppState,
    project_id: &Uuid,
    context: &RequestContext,
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    load_and_authorize_project_with_scopes(state, project_id, context, Some(&[])).await
}

async fn load_and_authorize_project_write(
    state: &AppState,
    project_id: &Uuid,
    context: &RequestContext,
    required_scoped_scopes: &[&str],
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    load_and_authorize_project_with_scopes(state, project_id, context, Some(required_scoped_scopes))
        .await
}

async fn load_and_authorize_project_with_scopes(
    state: &AppState,
    project_id: &Uuid,
    context: &RequestContext,
    required_scoped_scopes: Option<&[&str]>,
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, project_id).await?;

    if let Some(required_scoped_scopes) = required_scoped_scopes {
        ensure_project_scoped_write_access(
            &transaction,
            &project,
            context,
            None,
            required_scoped_scopes,
        )
        .await?;
    } else {
        ensure_project_access(&transaction, &project, context, None).await?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize project authorization: {error}"))
    })?;

    Ok(project)
}

#[instrument(skip(state))]
async fn get_origin_jwks(
    State(state): State<AppState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let config_jwks = build_origin_jwks(&state.config)
        .map_err(|error| internal_error(format!("failed to construct origin JWKS: {error}")))?;

    let mut keys: Vec<JsonValue> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Some(config_keys) = config_jwks.get("keys").and_then(|value| value.as_array()) {
        for key in config_keys {
            let Some(kid) = key.get("kid").and_then(JsonValue::as_str) else {
                continue;
            };
            let trimmed = kid.trim();
            if trimmed.is_empty() {
                continue;
            }
            if seen.insert(trimmed.to_string()) {
                keys.push(key.clone());
            }
        }
    }

    match load_runtime_signing_keys(&state.pool).await {
        Ok(db_keys) => {
            for (kid, x) in db_keys {
                if kid.trim().is_empty() || x.trim().is_empty() {
                    continue;
                }
                if !seen.insert(kid.clone()) {
                    continue;
                }
                keys.push(json!({
                    "kty": "OKP",
                    "crv": "Ed25519",
                    "alg": "EdDSA",
                    "use": "sig",
                    "kid": kid,
                    "x": x
                }));
            }
        }
        Err(error) => {
            warn!(
                ?error,
                "failed to load runtime signing keys for JWKS response"
            );
        }
    };

    Ok(Json(json!({ "keys": keys })))
}

fn build_origin_jwks(config: &AppConfig) -> Result<JsonValue> {
    build_origin_jwks_from_pem(
        config.origin_token_private_key.as_deref(),
        config.origin_token_public_key.as_deref(),
        config.origin_token_key_id.as_deref(),
    )
}

fn build_origin_jwks_from_pem(
    private_key_pem: Option<&str>,
    public_key_pem: Option<&str>,
    key_id: Option<&str>,
) -> Result<JsonValue> {
    let raw_public_key = if let Some(private_key_pem) = private_key_pem {
        match derive_ed25519_public_key_from_private_pem(private_key_pem) {
            Ok(raw) => Some(raw),
            Err(error) => {
                if let Some(public_key_pem) = public_key_pem {
                    Some(extract_ed25519_public_key_from_public_pem(public_key_pem)?)
                } else if let Ok(raw) = extract_ed25519_public_key_from_public_pem(private_key_pem)
                {
                    Some(raw)
                } else {
                    return Err(error);
                }
            }
        }
    } else if let Some(public_key_pem) = public_key_pem {
        Some(extract_ed25519_public_key_from_public_pem(public_key_pem)?)
    } else {
        None
    };

    let Some(raw_public_key) = raw_public_key else {
        return Ok(json!({ "keys": [] }));
    };

    let x = URL_SAFE_NO_PAD.encode(raw_public_key);
    let kid = key_id.map(|value| value.to_string()).unwrap_or_else(|| {
        if let Some(pem) = private_key_pem.or(public_key_pem) {
            crate::tokens::derive_origin_key_id_from_pem(pem)
        } else {
            "origin-key".to_string()
        }
    });

    Ok(json!({
        "keys": [
            {
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": kid,
                "x": x
            }
        ]
    }))
}

pub(crate) async fn register_runtime_signing_key(state: &AppState) -> anyhow::Result<()> {
    let jwks = build_origin_jwks(&state.config)?;
    let Some(key) = jwks
        .get("keys")
        .and_then(JsonValue::as_array)
        .and_then(|keys| keys.first())
    else {
        return Ok(());
    };

    let Some(kid) = key.get("kid").and_then(JsonValue::as_str) else {
        return Ok(());
    };
    let kid = kid.trim();
    if kid.is_empty() {
        return Ok(());
    }

    let Some(x) = key.get("x").and_then(JsonValue::as_str) else {
        return Ok(());
    };
    let x = x.trim();
    if x.is_empty() {
        return Ok(());
    }

    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire database connection for signing key registration")?;

    let mut ensured = false;
    for attempt in 0..2 {
        match connection
            .execute(
                "insert into runtime_signing_keys (key_id, x)
                 values ($1, $2)
                 on conflict (key_id) do update set
                   x = excluded.x,
                   updated_at = now()",
                &[&kid, &x],
            )
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) => {
                if attempt == 0
                    && !ensured
                    && error
                        .as_db_error()
                        .map(|db| db.code() == &tokio_postgres::error::SqlState::UNDEFINED_TABLE)
                        .unwrap_or(false)
                {
                    ensure_runtime_signing_keys_table(&*connection).await?;
                    ensured = true;
                    continue;
                }
                return Err(error).context("failed to upsert runtime signing key");
            }
        }
    }

    Ok(())
}

async fn load_runtime_signing_keys(pool: &PgPool) -> anyhow::Result<Vec<(String, String)>> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire database connection for signing key lookup")?;

    let mut ensured = false;
    for attempt in 0..2 {
        match connection
            .query(
                "select key_id, x from runtime_signing_keys order by updated_at desc",
                &[],
            )
            .await
        {
            Ok(rows) => {
                return Ok(rows
                    .into_iter()
                    .filter_map(|row| {
                        let kid: String = row.get("key_id");
                        let x: String = row.get("x");
                        Some((kid, x))
                    })
                    .collect());
            }
            Err(error) => {
                if attempt == 0
                    && !ensured
                    && error
                        .as_db_error()
                        .map(|db| db.code() == &tokio_postgres::error::SqlState::UNDEFINED_TABLE)
                        .unwrap_or(false)
                {
                    ensure_runtime_signing_keys_table(&*connection).await?;
                    ensured = true;
                    continue;
                }
                return Err(error).context("failed to query runtime signing keys");
            }
        }
    }

    Ok(Vec::new())
}

async fn ensure_runtime_signing_keys_table(client: &impl GenericClient) -> anyhow::Result<()> {
    client
        .batch_execute(
            "
            create table if not exists runtime_signing_keys (
              key_id text primary key,
              x text not null,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );

            alter table runtime_signing_keys enable row level security;
            revoke all privileges on table runtime_signing_keys from anon, authenticated;
            ",
        )
        .await?;
    Ok(())
}

fn decode_pem_section_der(pem: &str, section_label: &str, label: &str) -> Result<Vec<u8>> {
    let begin_marker = format!("-----BEGIN {section_label}-----");
    let end_marker = format!("-----END {section_label}-----");

    let Some(begin_index) = pem.find(&begin_marker) else {
        return Err(anyhow!("{label} is missing PEM section {section_label}"));
    };
    let body_start = begin_index + begin_marker.len();

    let Some(end_offset) = pem[body_start..].find(&end_marker) else {
        return Err(anyhow!(
            "{label} PEM section {section_label} is missing closing marker"
        ));
    };
    let body_end = body_start + end_offset;
    let body_raw = &pem[body_start..body_end];

    let body: String = body_raw
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();

    if body.trim().is_empty() {
        return Err(anyhow!("{label} PEM section {section_label} is empty"));
    }

    STANDARD
        .decode(body.as_bytes())
        .with_context(|| format!("failed to decode {label} PEM section {section_label}"))
}

fn derive_ed25519_public_key_from_private_pem(private_key_pem: &str) -> Result<Vec<u8>> {
    let der = decode_pem_section_der(private_key_pem, "PRIVATE KEY", "origin private key")?;

    let key_pair = Ed25519KeyPair::from_pkcs8(der.as_slice())
        .context("failed to parse origin private key as PKCS#8 Ed25519 keypair")?;

    Ok(key_pair.public_key().as_ref().to_vec())
}

fn extract_ed25519_public_key_from_public_pem(public_key_pem: &str) -> Result<Vec<u8>> {
    let der = decode_pem_section_der(public_key_pem, "PUBLIC KEY", "origin public key")?;

    if der.len() < 32 {
        return Err(anyhow!("origin public key is too short"));
    }

    let raw_key = &der[der.len().saturating_sub(32)..];
    if raw_key.len() != 32 {
        return Err(anyhow!(
            "origin public key must contain 32-byte Ed25519 key material"
        ));
    }

    Ok(raw_key.to_vec())
}
