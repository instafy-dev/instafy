//! Codex's standalone native search route (used by Responses Lite models).
//! Account authority is identical to hosted search. This is a JSON pass-through,
//! not another completion or a managed-credit operation.

use super::*;
use crate::client::{parse_codex_rate_limit_headers, read_model_error_body};
use crate::model_transport::ResponseBodyLimit;

fn unavailable() -> AppError {
    AppError {
        status: StatusCode::FORBIDDEN,
        error_type: "permission_error",
        message: "Native web search requires an authorized onboarded ChatGPT job".into(),
        code: Some("native_web_search_unavailable"),
        upstream: None,
    }
}

fn endpoint(credentials: &Credentials) -> Result<Url> {
    let mut url = Url::parse(credentials.endpoint()).context("invalid search provider endpoint")?;
    let prefix = url
        .path()
        .strip_suffix("/responses")
        .ok_or_else(|| anyhow!("search provider must use a Responses endpoint"))?
        .to_string();
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        anyhow::bail!("invalid search provider endpoint");
    }
    url.set_path(&format!("{prefix}/alpha/search"));
    Ok(url)
}

pub(super) async fn search(
    State(state): State<ProxyState>,
    AuthenticatedProxyClaims(claims): AuthenticatedProxyClaims,
    Json(payload): Json<Value>,
) -> Result<Response, AppError> {
    // Refuse managed, static and legacy grants before requesting credential material.
    if !native_web_search_claims_allowed(claims.as_ref()) {
        return Err(unavailable());
    }
    let lane = classify_upstream_lane(claims.as_ref())?;
    let UpstreamLane::Byo { credential_id } = lane else {
        return Err(unavailable());
    };
    for field in ["id", "model"] {
        if payload
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(AppError::bad_request(anyhow!(
                "native search requires {field}"
            )));
        }
    }
    let mut leased = state.lease_for_lane(lane).await?.leased;
    let transport = ModelTransportConfig::from_env().map_err(AppError::internal)?;
    // No alternate host or redirect may acquire this account's access token.
    let http = transport
        .http_client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(AppError::upstream)?;
    let diagnostics = UsageDiagnostics::from_env(claims.as_ref());
    let model = payload["model"].as_str().expect("validated model");
    for attempt_number in 0..2 {
        if !native_web_search_allowed(&leased, claims.as_ref()) {
            return Err(unavailable());
        }
        let url = endpoint(&leased.credentials).map_err(AppError::upstream)?;
        let mut request = http
            .post(url)
            .bearer_auth(leased.credentials.bearer())
            .header("accept", "application/json")
            .header("accept-encoding", "identity")
            .json(&payload);
        if let Some(account_id) = leased.credentials.chatgpt_account_id() {
            request = request.header("ChatGPT-Account-Id", account_id);
        }
        let mut diagnostic = diagnostics
            .as_ref()
            .map(|d| d.start(model, "search", &payload));
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                if let Some(d) = diagnostic.as_mut() {
                    d.failure("transport_error");
                }
                return Err(AppError::upstream(error));
            }
        };
        spawn_credential_usage_report(
            state.controller.as_ref(),
            Some(credential_id),
            parse_codex_rate_limit_headers(response.headers()).as_ref(),
        );
        let status = response.status();
        if let Some(d) = diagnostic.as_mut() {
            d.http_status(status.as_u16());
        }
        if !status.is_success() {
            if let Some(d) = diagnostic.as_mut() {
                d.failure("http_error");
            }
            let headers = response.headers().clone();
            let body = read_model_error_body(response, transport.max_response_bytes)
                .await
                .map_err(AppError::upstream)?;
            if attempt_number == 0 && response_indicates_chatgpt_token_expired(status, &body) {
                // One explicit controller refresh, as for Responses; no rate-limit or
                // transient-error retry here. Codex owns its bounded retry policy.
                eprintln!("[proxy] renewing expired ChatGPT lease for native search");
                let controller = state.controller.as_ref().ok_or_else(unavailable)?;
                leased = controller
                    .renew_credential_lease_after_rejection(credential_id)
                    .await
                    .context(UpstreamFailure::CredentialRefresh)
                    .map_err(AppError::upstream)?
                    .into_material()
                    .context(UpstreamFailure::CredentialRefresh)
                    .map_err(AppError::upstream)?;
                continue;
            }
            return Err(AppError::upstream(UpstreamFailure::http_body(
                status, &headers, &body,
            )));
        }
        if response
            .content_length()
            .is_some_and(|bytes| bytes > transport.max_response_bytes as u64)
        {
            if let Some(d) = diagnostic.as_mut() {
                d.failure("error");
            }
            return Err(AppError::upstream(UpstreamFailure::ResponseTooLarge));
        }
        // Keep the body owned by the downstream response. Cancellation drops the
        // upstream socket; chunks are bounded without buffering opaque search output.
        let body = stream::try_unfold(
            (
                response,
                ResponseBodyLimit::new(transport.max_response_bytes),
                diagnostic,
            ),
            |(mut response, mut limit, mut diagnostic)| async move {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if limit.receive(chunk.len()).is_err() {
                            if let Some(d) = diagnostic.as_mut() {
                                d.failure("error");
                            }
                            return Err(std::io::Error::other(
                                "native search response exceeded the configured byte limit",
                            ));
                        }
                        Ok(Some((chunk, (response, limit, diagnostic))))
                    }
                    Ok(None) => {
                        // The native SearchResponse has no token-usage contract. A
                        // completed attempt is known; its token charge remains unknown.
                        if let Some(d) = diagnostic.as_mut() {
                            d.observe_json(&json!({}));
                        }
                        Ok(None)
                    }
                    Err(_) => {
                        if let Some(d) = diagnostic.as_mut() {
                            d.failure("transport_error");
                        }
                        Err(std::io::Error::other(
                            "native search response transport failed",
                        ))
                    }
                }
            },
        );
        return Ok((
            status,
            [("content-type", "application/json")],
            Body::from_stream(body),
        )
            .into_response());
    }
    unreachable!("the second rejected attempt returns an error")
}
