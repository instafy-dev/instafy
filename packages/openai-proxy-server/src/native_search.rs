//! Codex's standalone native search route (used by Responses Lite models).
//! A person's own ChatGPT login passes it through to ChatGPT's search
//! endpoint; account authority is identical to hosted search. This is a JSON
//! pass-through, not another completion or a managed-credit operation.
//!
//! With `PROXY_MANAGED_NATIVE_WEB_SEARCH` on, a managed run the controller
//! granted search may search too, through the search bridge
//! ([`crate::search_bridge`]): OpenAI's hosted `web_search` on the platform's
//! API key, or a static ChatGPT login's own search (a local stack), one clean
//! query at a time, and only as many as the controller's check before them
//! lets run. A managed run's search that may not run is answered, not
//! refused: the model reads why, and its turn goes on.

use super::*;
use crate::client::{parse_codex_rate_limit_headers, read_model_error_body};
use crate::controller_client::ManagedSearchJob;
use crate::model_transport::ResponseBodyLimit;
use crate::search_bridge::{self, Engine, RecordScope, SearchCall, SearchRequest, Withheld};

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

/// A managed run's job token: bound to its job and lease attempt, on the
/// platform lane (a run id and no credential of its own), whatever its grant
/// says of search. Only such a run's search is answered with why it may not
/// run ([`managed_search`]); every other token without search is refused.
fn managed_job_claims(claims: Option<&ProxyClaims>) -> bool {
    claims.is_some_and(|claims| {
        claims.job_id.is_some()
            && claims.lease_attempt.is_some_and(|attempt| attempt > 0)
            && credential_id_from_claims(Some(claims)).is_none()
            && run_id_from_claims(Some(claims)).is_some()
    })
}

/// The job a managed run's token names, for the controller's check.
fn managed_search_job(claims: Option<&ProxyClaims>) -> Option<ManagedSearchJob> {
    let claims = claims?;
    let id = |value: &str| Uuid::parse_str(value.trim()).ok();
    Some(ManagedSearchJob {
        project_id: id(&claims.project_id)?,
        job_id: id(claims.job_id.as_deref()?)?,
        lease_attempt: i32::try_from(claims.lease_attempt?).ok()?,
        run_id: id(run_id_from_claims(Some(claims))?)?,
    })
}

/// One log line for searches a managed run's request planned and did not run,
/// with the job and why, and never a query.
fn log_withheld(claims: Option<&ProxyClaims>, asked: usize, granted: usize, why: Withheld) {
    eprintln!(
        "[proxy] managed web search withheld {}",
        json!({
            "jobId": claims.and_then(|claims| claims.job_id.as_deref()),
            "runId": run_id_from_claims(claims),
            "leaseAttempt": claims.and_then(|claims| claims.lease_attempt),
            "asked": asked,
            "granted": granted,
            "reason": why.name(),
        })
    );
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
    } else if managed_job_claims(claims.as_ref()) {
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
///
/// Its searches run only with this proxy's `PROXY_MANAGED_NATIVE_WEB_SEARCH`
/// on and the grant's search, and only as many as the controller lets run
/// (runtime-controller `managed_web_search`): it counts a message's searches
/// across its jobs and refuses them while its own switch is off. Searches it
/// let run that did not search go back to it. A search that may not run is
/// answered with why, searches nothing and costs nothing, so the turn goes on.
async fn managed_search(
    state: &ProxyState,
    claims: Option<&ProxyClaims>,
    payload: &Value,
) -> Result<Response, AppError> {
    if !state.managed_native_web_search || !managed_native_web_search_claims_allowed(claims) {
        log_withheld(claims, 0, 0, Withheld::Off);
        return Ok(Json(search_bridge::not_searched(Withheld::Off)).into_response());
    }
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
    let mut plan = request.plan(&[leased.credentials.bearer()]);
    let asked = plan.searches();
    let job = managed_search_job(claims);
    let granted = if asked == 0 {
        0
    } else {
        let claimed = match (state.controller.as_ref(), job.as_ref()) {
            (Some(controller), Some(job)) => controller
                .claim_managed_web_searches(job, asked as u32)
                .await
                .map_err(|error| {
                    eprintln!("[proxy] managed web search check failed: {error}");
                })
                .ok(),
            _ => None,
        };
        let (granted, why) = match claimed {
            Some(claim) => (
                (claim.granted as usize).min(asked),
                Withheld::from_refusal(claim.refused.as_deref(), claim.limit),
            ),
            None => (0, Withheld::Unchecked),
        };
        if granted < asked {
            log_withheld(claims, asked, granted, why);
            plan.withhold(granted, why);
        }
        granted
    };
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
    let answer = search_bridge::answer(&call, &plan, &RecordScope::from_claims(claims)).await;
    // What the controller let run and did not search (a search that failed)
    // goes back to the message before the model reads the answer.
    let ran = answer.as_ref().map_or(0, search_bridge::searches_in);
    if let (Some(controller), Some(job)) = (state.controller.as_ref(), job.as_ref())
        && granted > ran
        && let Err(error) = controller
            .give_back_managed_web_searches(job, (granted - ran) as u32)
            .await
    {
        eprintln!("[proxy] managed web search give-back failed: {error}");
    }
    Ok(Json(answer.map_err(AppError::upstream)?).into_response())
}
