use axum::{
    body::{to_bytes, Body},
    extract::{Path, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
    routing::any,
    Json, Router,
};
use reqwest::Url;
use serde::Deserialize;
use serde_json::json;
use tracing::{instrument, warn};

use crate::auth::authenticate_request;
use crate::bug_reports::{record_system_bug_report, SystemBugReportInput};
use crate::errors::{bad_gateway, bad_request, forbidden, internal_error, ApiError};
use crate::origins::{is_hop_by_hop_header, resolve_origin_proxy_upstream_endpoint};
use crate::projects::{
    ensure_project_access, ensure_project_write_access, load_project_record,
    parse_optional_uuid_param,
};
use crate::state::AppState;
use crate::tunnels::project_has_active_runtime_tunnel_hostname;

const SPEECH_PROXY_MAX_BODY_BYTES: usize = 300 * 1024 * 1024;
const UPSTREAM_AUTH_HEADER: &str = "x-instafy-upstream-authorization";

#[derive(Debug, Deserialize)]
struct ProjectSpeechProxyBasePathParams {
    project_id: String,
    encoded_base: String,
}

#[derive(Debug, Deserialize)]
struct ProjectSpeechProxyPathParams {
    project_id: String,
    encoded_base: String,
    path: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/speech/proxy/:encoded_base",
            any(proxy_project_speech_request_base),
        )
        .route(
            "/projects/:project_id/speech/proxy/:encoded_base/*path",
            any(proxy_project_speech_request_path),
        )
}

fn speech_proxy_endpoint_is_allowed(endpoint: &str) -> bool {
    let url = match Url::parse(endpoint.trim()) {
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

    let Some(host) = url.host_str() else {
        return false;
    };
    let normalized = host.trim().to_ascii_lowercase();
    normalized == "rt.test"
        || normalized.ends_with(".rt.test")
        || normalized == "rt.instafy.dev"
        || normalized.ends_with(".rt.instafy.dev")
}

fn classify_speech_proxy_request(
    method: &Method,
    path: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let normalized = path.trim().trim_start_matches('/');
    match *method {
        Method::GET | Method::HEAD => {
            if normalized == "health" {
                Ok(())
            } else {
                Err(crate::not_found("speech path not found"))
            }
        }
        Method::POST => {
            if normalized == "transcribe" || normalized == "synthesize" {
                Ok(())
            } else {
                Err(crate::not_found("speech path not found"))
            }
        }
        _ => Err((
            StatusCode::METHOD_NOT_ALLOWED,
            Json(ApiError::new("method not allowed")),
        )),
    }
}

fn build_upstream_speech_url(
    base: &str,
    path: &str,
    query: Option<&str>,
) -> Result<(String, Option<String>), (StatusCode, Json<ApiError>)> {
    let (resolved_base, host_override) = resolve_origin_proxy_upstream_endpoint(base);
    let mut url = Url::parse(&resolved_base)
        .map_err(|error| bad_request(format!("invalid speech endpoint: {error}")))?;

    let base_path = url.path().trim_end_matches('/');
    let suffix = path.trim().trim_start_matches('/');
    let joined_path = if suffix.is_empty() {
        if base_path.is_empty() {
            "/".to_string()
        } else {
            base_path.to_string()
        }
    } else if base_path.is_empty() || base_path == "/" {
        format!("/{suffix}")
    } else {
        format!("{base_path}/{suffix}")
    };
    url.set_path(&joined_path);
    if let Some(raw_query) = query.filter(|value| !value.trim().is_empty()) {
        url.set_query(Some(raw_query));
    } else {
        url.set_query(None);
    }

    Ok((url.to_string(), host_override))
}

async fn authorize_project_request(
    state: &AppState,
    headers: &HeaderMap,
    project_id_raw: String,
    require_write: bool,
) -> Result<uuid::Uuid, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    let project_id = parse_optional_uuid_param(Some(project_id_raw), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    if require_write {
        ensure_project_write_access(&transaction, &project, &context, None).await?;
    } else {
        ensure_project_access(&transaction, &project, &context, None).await?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize authorization: {error}")))?;

    Ok(project_id)
}

async fn proxy_speech_request_inner(
    state: AppState,
    request: Request,
    project_id_raw: String,
    encoded_base: String,
    path: String,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let headers = request.headers().clone();
    let method = request.method().clone();
    classify_speech_proxy_request(&method, &path)?;
    let project_id =
        authorize_project_request(&state, &headers, project_id_raw, method == Method::POST).await?;

    let base = encoded_base.trim();
    if base.is_empty() {
        return Err(bad_request("speech proxy base is required"));
    }
    if !speech_proxy_endpoint_is_allowed(base) {
        return Err(forbidden(
            "speech proxy only supports Instafy tunnel endpoints",
        ));
    }
    let base_url = Url::parse(base)
        .map_err(|error| bad_request(format!("invalid speech endpoint: {error}")))?;
    let hostname = base_url
        .host_str()
        .map(|value| value.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("speech proxy base is missing a hostname"))?;
    let tunnel_matches_project =
        project_has_active_runtime_tunnel_hostname(&state.pool, &project_id, &hostname).await?;
    if !tunnel_matches_project {
        return Err(forbidden(
            "speech proxy base is not an active tunnel for this project",
        ));
    }

    let raw_query = request.uri().query().map(|value| value.to_string());
    let (upstream_url, host_override) =
        build_upstream_speech_url(base, &path, raw_query.as_deref())?;

    let upstream_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| bad_request("invalid proxy method"))?;
    let mut builder = state
        .origin_proxy_client
        .request(upstream_method, upstream_url);
    if let Some(host) = host_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        builder = builder.header("host", host);
    }
    if let Some(value) = headers
        .get(UPSTREAM_AUTH_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
    {
        builder = builder.header("authorization", value.trim());
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

    let body = to_bytes(request.into_body(), SPEECH_PROXY_MAX_BODY_BYTES)
        .await
        .map_err(|error| {
            internal_error(format!("failed to read speech proxy request body: {error}"))
        })?;
    let upstream = match builder.body(body).send().await {
        Ok(upstream) => upstream,
        Err(error) => {
            let error_message = error.to_string();
            record_speech_proxy_system_issue(
                &state,
                project_id,
                "request_failed",
                &method,
                &path,
                &hostname,
                &error_message,
            )
            .await;
            return Err(bad_gateway(format!(
                "speech proxy request failed: {error_message}"
            )));
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let response_headers = upstream.headers().clone();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            let error_message = error.to_string();
            record_speech_proxy_system_issue(
                &state,
                project_id,
                "response_body_failed",
                &method,
                &path,
                &hostname,
                &error_message,
            )
            .await;
            return Err(bad_gateway(format!(
                "failed to read speech proxy response body: {error_message}"
            )));
        }
    };

    let mut response = Response::builder().status(status);
    for (name, value) in response_headers.iter() {
        if is_hop_by_hop_header(name.as_str()) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            response = response.header(name.as_str(), value);
        }
    }

    response
        .body(Body::from(bytes))
        .map_err(|error| internal_error(format!("failed to build speech proxy response: {error}")))
}

async fn record_speech_proxy_system_issue(
    state: &AppState,
    project_id: uuid::Uuid,
    stage: &str,
    method: &Method,
    path: &str,
    hostname: &str,
    error_message: &str,
) {
    if let Err(report_error) = record_system_bug_report(
        state,
        SystemBugReportInput {
            message: "Speech proxy upstream request failed".to_string(),
            details: Some(error_message.to_string()),
            project_id: Some(project_id),
            runtime_id: None,
            run_id: None,
            conversation_id: None,
            priority: "high".to_string(),
            labels: vec![
                "proxy".to_string(),
                "speech".to_string(),
                "runtime".to_string(),
                "monitoring".to_string(),
            ],
            metadata: json!({
                "source": "speech.proxy",
                "stage": stage,
                "method": method.as_str(),
                "path": path,
                "hostname": hostname,
            }),
            logs: json!([
                {
                    "kind": "speech.proxy.failed",
                    "stage": stage,
                    "method": method.as_str(),
                    "path": path,
                    "hostname": hostname,
                    "error": error_message,
                }
            ]),
            fingerprint: Some(format!("speech.proxy.{stage}")),
            dedupe_window_seconds: Some(15 * 60),
        },
    )
    .await
    {
        warn!(%report_error, "failed to record speech proxy system issue");
    }
}

#[instrument(skip_all)]
async fn proxy_project_speech_request_base(
    State(state): State<AppState>,
    Path(params): Path<ProjectSpeechProxyBasePathParams>,
    request: Request,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    proxy_speech_request_inner(
        state,
        request,
        params.project_id,
        params.encoded_base,
        String::new(),
    )
    .await
}

#[instrument(skip_all)]
async fn proxy_project_speech_request_path(
    State(state): State<AppState>,
    Path(params): Path<ProjectSpeechProxyPathParams>,
    request: Request,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    proxy_speech_request_inner(
        state,
        request,
        params.project_id,
        params.encoded_base,
        params.path,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_proxy_endpoint_is_allowed_for_instafy_tunnels_only() {
        assert!(speech_proxy_endpoint_is_allowed("http://abc.rt.test:8443"));
        assert!(speech_proxy_endpoint_is_allowed(
            "https://abc.rt.instafy.dev"
        ));
        assert!(!speech_proxy_endpoint_is_allowed("http://127.0.0.1:8796"));
        assert!(!speech_proxy_endpoint_is_allowed(
            "https://speech.example.com"
        ));
        assert!(!speech_proxy_endpoint_is_allowed("file:///tmp/speech"));
    }

    #[test]
    fn build_upstream_speech_url_rewrites_local_rt_test_to_loopback() {
        let (url, host_override) =
            build_upstream_speech_url("http://abc.rt.test:8443", "transcribe", None)
                .expect("proxy url");
        assert_eq!(url, "http://127.0.0.1:8443/transcribe");
        assert_eq!(host_override.as_deref(), Some("abc.rt.test:8443"));
    }
}
