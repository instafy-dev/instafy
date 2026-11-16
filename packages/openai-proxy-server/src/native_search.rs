//! Codex's standalone native search route (used by Responses Lite models).
//! A person's own ChatGPT login passes it through to ChatGPT's search
//! endpoint; account authority is identical to hosted search. This is a JSON
//! pass-through, not another completion or a managed-credit operation.
//!
//! With `PROXY_MANAGED_NATIVE_WEB_SEARCH` on, a managed run the controller
//! granted search may search too, through the search bridge
//! ([`crate::search_bridge`]): OpenAI's hosted `web_search` on the platform's
//! API key, or a static ChatGPT login's own search (a local stack), one clean
//! query at a time.

use super::*;
use crate::client::{parse_codex_rate_limit_headers, read_model_error_body};
use crate::model_transport::ResponseBodyLimit;
use crate::search_bridge::{self, Engine, RecordScope, SearchCall, SearchRequest};

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

/// Whose search a request runs, from its token alone.
#[derive(Clone, Copy)]
enum SearchLane<'a> {
    /// A person's own ChatGPT login, by its controller credential.
    Own { credential_id: &'a str },
    /// A managed run on the platform's credentials.
    Managed,
}

pub(super) async fn search(
    State(state): State<ProxyState>,
    AuthenticatedProxyClaims(claims): AuthenticatedProxyClaims,
    Json(payload): Json<Value>,
) -> Result<Response, AppError> {
    // Refuse managed, static and legacy grants before requesting credential
    // material, unless the switch lets a managed run the controller granted
    // search use the search bridge.
    let lane = if native_web_search_claims_allowed(claims.as_ref()) {
        let UpstreamLane::Byo { credential_id } = classify_upstream_lane(claims.as_ref())? else {
            return Err(unavailable());
        };
        SearchLane::Own { credential_id }
    } else if state.managed_native_web_search
        && managed_native_web_search_claims_allowed(claims.as_ref())
    {
        SearchLane::Managed
    } else {
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
    let credential_id = match lane {
        SearchLane::Own { credential_id } => credential_id,
        SearchLane::Managed => return managed_search(&state, claims.as_ref(), &payload).await,
    };
    let mut leased = state
        .lease_for_lane(UpstreamLane::Byo { credential_id })
        .await?
        .leased;
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

/// A managed run's search, through the search bridge on the platform's
/// credentials: OpenAI's hosted search on an API key, as the configured
/// search model, or a static ChatGPT login's own search (a local stack), as
/// the pinned model. Each search is recorded. Other credentials get none.
async fn managed_search(
    state: &ProxyState,
    claims: Option<&ProxyClaims>,
    payload: &Value,
) -> Result<Response, AppError> {
    let request = SearchRequest::read(payload).map_err(AppError::bad_request)?;
    let mut leased = state.lease_for_lane(UpstreamLane::Platform).await?.leased;
    if leased.credentials.is_chatgpt() {
        // A model request on this login may have refreshed it. This route
        // does not renew it.
        let _ = leased
            .credentials
            .reload_chatgpt_access_token_from_auth_path();
    }
    let requested_model = payload["model"].as_str().expect("validated model").trim();
    let (engine, model) = match &leased.credentials {
        Credentials::ChatGpt { .. } => (
            Engine::ChatGptSearch {
                endpoint: endpoint(&leased.credentials).map_err(AppError::upstream)?,
            },
            leased.pinned_model().unwrap_or(requested_model),
        ),
        Credentials::ApiKey { .. }
            if search_bridge::is_responses_endpoint(leased.credentials.endpoint()) =>
        {
            (
                Engine::HostedWebSearch,
                search_bridge::search_model(
                    state.managed_web_search_model.as_deref(),
                    leased.pinned_model(),
                    requested_model,
                ),
            )
        }
        _ => return Err(unavailable()),
    };
    let plan = request.plan(&[leased.credentials.bearer()]);
    let transport = ModelTransportConfig::from_env().map_err(AppError::internal)?;
    // No alternate host or redirect may acquire the platform's credentials.
    let http = transport
        .http_client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(AppError::upstream)?;
    let call = SearchCall::new(
        &http,
        &leased.credentials,
        model,
        engine,
        state.service_tier_endpoints,
        transport.max_response_bytes,
    );
    let answer = search_bridge::answer(&call, &plan, &RecordScope::from_claims(claims))
        .await
        .map_err(AppError::upstream)?;
    Ok(Json(answer).into_response())
}
