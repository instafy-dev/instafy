//! Request authorization shared by the single-tenant routes and the hosted
//! gateway's routes: bearer or query tokens, scope checks, and the live
//! workspace lease every `fs.write` request must hold.

use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::Response;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::{OriginClaims, TokenValidator};
use crate::config::ServerConfig;
use crate::error::OriginError;

/// The bearer that authorized a request, for handlers that exchange it with
/// the controller (git credentials).
#[derive(Clone, Debug)]
pub(crate) struct OriginAccessToken {
    pub(crate) token: String,
}

/// What a route needs to authorize a request.
#[derive(Clone)]
pub(crate) struct RouteAuth {
    pub(crate) config: Arc<ServerConfig>,
    pub(crate) token_validator: TokenValidator,
    pub(crate) http_client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct ActiveWorkspaceLeaseEnvelope {
    lease: Option<ActiveWorkspaceLease>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveWorkspaceLease {
    lease_id: Uuid,
    project_id: Uuid,
    user_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    expires_at: DateTime<Utc>,
}

/// The project a request is for: the token's project on a multi-tenant
/// gateway, the origin's own project otherwise.
pub(crate) fn project_id_for_claims(
    config: &ServerConfig,
    claims: &OriginClaims,
) -> Result<Uuid, OriginError> {
    if config.multi_tenant {
        return Uuid::parse_str(claims.project_id.trim())
            .map_err(|_| OriginError::unauthorized("invalid project id"));
    }
    Ok(config.project_id)
}

pub(crate) async fn authorize_and_continue(
    auth: &RouteAuth,
    mut request: Request,
    next: Next,
    required_scopes: &[&str],
) -> Result<Response, OriginError> {
    let mut headers = request.headers().clone();
    let mut authenticated_from_query = false;

    if !auth.config.skip_auth && !headers.contains_key(header::AUTHORIZATION) {
        if request.method() == Method::GET || request.method() == Method::HEAD {
            if let Some(token) = token_from_query(request.uri().query()) {
                if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    headers.insert(header::AUTHORIZATION, value);
                    authenticated_from_query = true;
                }
            }
        }
    }

    let claims = auth
        .token_validator
        .authorize(&auth.config, &headers, required_scopes)
        .await?;

    let token = bearer_token_from_headers(&headers).unwrap_or_default();

    // `fs.write` is a live-lease capability, not merely a signed bearer
    // capability. Check the controller immediately before dispatching to any
    // mutating handler so apply, JSON apply, Git sync, and both revert routes
    // all fail closed through one authorization gate.
    if required_scopes.contains(&"fs.write") {
        authorize_active_write_lease(auth, &claims, &token).await?;
    }

    request.extensions_mut().insert(claims);
    request.extensions_mut().insert(OriginAccessToken { token });
    let mut response = next.run(request).await;
    if authenticated_from_query {
        response.headers_mut().insert(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        );
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store, max-age=0"),
        );
    }
    Ok(response)
}

pub(crate) fn bearer_token_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let mut parts = value.split_whitespace();
            match (parts.next(), parts.next(), parts.next()) {
                (Some(scheme), Some(token), None) if scheme.eq_ignore_ascii_case("bearer") => {
                    Some(token.trim().to_string())
                }
                _ => None,
            }
        })
        .filter(|token| !token.is_empty())
}

pub(crate) async fn authorize_active_write_lease(
    auth: &RouteAuth,
    claims: &OriginClaims,
    access_token: &str,
) -> Result<(), OriginError> {
    // Explicitly preserve the documented local-development escape hatch.
    if auth.config.skip_auth {
        return Ok(());
    }

    let token = access_token.trim();
    if token.is_empty() {
        return Err(OriginError::unauthorized(
            "origin write authorization token is required",
        ));
    }

    let project_id = project_id_for_claims(&auth.config, claims)?;
    let claimed_lease_id = claims
        .lease_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| OriginError::unauthorized("origin write token is missing its lease"))
        .and_then(|value| {
            Uuid::parse_str(value)
                .map_err(|_| OriginError::unauthorized("origin write token lease is invalid"))
        })?;

    let claimed_runtime_id = claims
        .runtime_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value)
                .map_err(|_| OriginError::unauthorized("origin write token runtime is invalid"))
        })
        .transpose()?;

    let mut url = auth.config.controller_base_url.clone();
    url.path_segments_mut()
        .map_err(|_| OriginError::internal("controller base url missing path segments"))?
        .extend(["projects", &project_id.to_string(), "lease"]);

    let response = auth
        .http_client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| {
            OriginError::unavailable(format!(
                "workspace lease authorization is unavailable: {error}"
            ))
        })?;
    if !response.status().is_success() {
        return Err(OriginError::unauthorized(format!(
            "controller rejected workspace lease authorization (status {})",
            response.status()
        )));
    }

    let payload = response
        .json::<ActiveWorkspaceLeaseEnvelope>()
        .await
        .map_err(|error| {
            OriginError::unavailable(format!(
                "workspace lease authorization response is invalid: {error}"
            ))
        })?;
    let lease = payload
        .lease
        .ok_or_else(|| OriginError::unauthorized("an active workspace lease is required"))?;

    if lease.lease_id != claimed_lease_id || lease.project_id != project_id {
        return Err(OriginError::unauthorized(
            "workspace lease does not match the origin write token",
        ));
    }
    if lease.expires_at <= Utc::now() {
        return Err(OriginError::unauthorized(
            "workspace lease is no longer active",
        ));
    }

    // When the controller minted a runtime-scoped origin token, preserve that
    // exact runtime binding. User-driven hosted-origin calls may intentionally
    // omit a runtime claim even though the UI recorded its runtime hint on the
    // workspace lease, so absence is not upgraded into a runtime assertion.
    if let Some(claimed_runtime_id) = claimed_runtime_id {
        if lease.runtime_id != Some(claimed_runtime_id) {
            return Err(OriginError::unauthorized(
                "workspace lease runtime does not match the origin write token",
            ));
        }
    }

    let lease_user_id = lease.user_id.ok_or_else(|| {
        OriginError::unauthorized("active workspace lease is missing its user binding")
    })?;
    let claimed_user_id = Uuid::parse_str(claims.sub.trim()).map_err(|_| {
        OriginError::unauthorized("origin write token subject is not a workspace lease user")
    })?;
    if claimed_user_id != lease_user_id {
        return Err(OriginError::unauthorized(
            "workspace lease user does not match the origin write token",
        ));
    }

    Ok(())
}

fn token_from_query(query: Option<&str>) -> Option<String> {
    let query = query?.trim();
    if query.is_empty() {
        return None;
    }

    let parsed = reqwest::Url::parse(&format!("http://localhost/?{query}")).ok()?;
    for (key, value) in parsed.query_pairs() {
        if key == "token" || key == "access_token" {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}
