//! The save-only grant behind a running write job's rolling save.
//!
//! While a write job runs, its runtime saves the working folder's unfinished
//! work to canonical every two minutes and once more when the job ends,
//! through its own origin's `/workspace/persist`. The origin needs
//! `git.write` to push, and a runtime's machine credential can never mint
//! it; nor does a rolling save take a workspace lease, so it never holds
//! one against a person saving in Studio or the turn's own commit (an apply
//! or sync that finds a save holding the workspace waits for it).
//!
//! Instead the runtime presents the job's internal workspace token to
//! `POST /access_token {scopes: ["workspace.persist"], jobId}` and gets a
//! grant ([`WORKSPACE_PERSIST_SCOPE`]) when:
//!
//! - the job is leased by this runtime, or was cancelled in the last
//!   minute (the turn-end save of a stopped turn);
//! - the job may write the workspace, and its user still may;
//! - the runtime generation the token names is still the active one, and
//!   that generation's hosted origin is online;
//! - rolling saves are on (`WORKING_STATE_SAVES`, else 403
//!   `rolling_saves_off`).
//!
//! The grant's audience is that origin, so it never selects another one. It
//! opens the origin's `/workspace/persist` and nothing else, lives a minute,
//! and the origin exchanges it for `git.write`
//! ([`authorize_persist_grant`]) only after every one of those checks
//! passes again. Commits stay authored by the origin.

use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::{json, Value as JsonValue};
use tracing::info;
use uuid::Uuid;

use super::{
    job_allows_workspace_mutation, origin_endpoint_for_client, record_access_grant,
    AccessTokenRequest, ScopedGitMintContext, JOB_ORIGIN_TOKEN_MINT_SCOPE,
};
use crate::auth::RequestContext;
use crate::errors::{bad_request, forbidden, internal_error, unauthorized, ApiError};
use crate::projects::{
    ensure_project_write_access, ensure_scoped_project_match, load_project_record,
    parse_optional_uuid_param,
};
use crate::state::AppState;
use crate::tokens::{mint_scoped_token_expires_no_later_than, ScopedTokenRequest};

/// The scope of a rolling save's grant. The origin's own
/// `WORKSPACE_PERSIST_SCOPE` names the same string.
pub(crate) const WORKSPACE_PERSIST_SCOPE: &str = "workspace.persist";

/// The code of a grant refused because rolling saves are off.
pub(crate) const ROLLING_SAVES_OFF_CODE: &str = "rolling_saves_off";

/// How long a grant lives: one save, mint and exchange included.
const GRANT_TTL_SECONDS: i64 = 60;

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

/// The `/healthz` header that says this controller grants rolling saves:
/// `1` while `WORKING_STATE_SAVES` is on, `0` when it is off. A controller
/// that predates them sends none.
pub(crate) fn working_state_header(
    config: &crate::config::AppConfig,
) -> (&'static str, axum::http::HeaderValue) {
    (
        "x-instafy-working-state",
        axum::http::HeaderValue::from_static(if config.working_state_saves { "1" } else { "0" }),
    )
}

/// Whether an access token request asks for a rolling save's grant.
pub(crate) fn requests_persist_grant(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| scope.trim().eq_ignore_ascii_case(WORKSPACE_PERSIST_SCOPE))
}

fn rolling_saves_off() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::FORBIDDEN,
        Json(ApiError {
            message: "rolling saves are turned off".to_string(),
            code: Some(ROLLING_SAVES_OFF_CODE.to_string()),
            details: None,
        }),
    )
}

/// The ids a job token or a grant names.
struct Bound {
    subject_user: Uuid,
    runtime_id: Uuid,
    runtime_lease_id: Uuid,
    run_id: Uuid,
}

fn parse_claim(value: Option<&str>, what: &str) -> ApiResult<Uuid> {
    value
        .map(str::trim)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| unauthorized(format!("{what} is invalid")))
}

fn bound(claims: &runtime_contracts::AccessTokenClaims, label: &str) -> ApiResult<Bound> {
    Ok(Bound {
        subject_user: parse_claim(Some(claims.sub.as_str()), &format!("{label} subject"))?,
        runtime_id: parse_claim(claims.runtime_id.as_deref(), &format!("{label} runtime"))?,
        runtime_lease_id: parse_claim(
            claims.lease_id.as_deref(),
            &format!("{label} runtime generation"),
        )?,
        run_id: parse_claim(claims.run_id.as_deref(), &format!("{label} run"))?,
    })
}

/// The job behind a grant, and the online origin it saves through.
struct PersistJob {
    job_id: Uuid,
    origin_id: Uuid,
    origin_mode: String,
    origin_endpoint: String,
}

/// Check, in one transaction, that the job `bound` names may save now: it
/// is leased by that runtime (or was cancelled in the last minute), may
/// write, its user may still write, the runtime generation is the active
/// one, and that generation's hosted origin (`origin_id`, when the caller
/// names one) is online.
async fn load_persist_job(
    state: &AppState,
    project_id: &Uuid,
    bound: &Bound,
    job_id: Option<Uuid>,
    origin_id: Option<Uuid>,
) -> ApiResult<PersistJob> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to check a rolling save: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to check a rolling save: {error}")))?;
    let job = transaction
        .query_opt(
            "select j.id, j.payload, r.provider, r.capabilities, r.active_lease_id,
                    rl.project_id as lease_project_id,
                    rl.runtime_id as lease_runtime_id,
                    rl.status as lease_status,
                    rl.released_at
             from agent_jobs j
             join runtimes r on r.id = j.leased_by_runtime_id and r.project_id = j.project_id
             left join runtime_leases rl on rl.id = r.active_lease_id
             where j.project_id = $1
               and j.run_id = $2
               and j.leased_by_runtime_id = $3
               and ($4::uuid is null or j.id = $4)
               and (
                 (j.status = 'leased' and j.lease_expires_at > now())
                 or (j.status = 'canceled' and j.completed_at > now() - interval '60 seconds')
               )
               and r.status in ('ready', 'running', 'draining')
             order by j.leased_at desc nulls last
             limit 1",
            &[project_id, &bound.run_id, &bound.runtime_id, &job_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check a rolling save: {error}")))?
        .ok_or_else(|| unauthorized("the job is no longer running on this runtime"))?;
    let live_generation = job.get::<_, Option<Uuid>>("active_lease_id")
        == Some(bound.runtime_lease_id)
        && job.get::<_, Option<Uuid>>("lease_project_id") == Some(*project_id)
        && job.get::<_, Option<Uuid>>("lease_runtime_id") == Some(bound.runtime_id)
        && job.get::<_, Option<String>>("lease_status").as_deref() == Some("active")
        && job.get::<_, Option<DateTime<Utc>>>("released_at").is_none();
    if !live_generation {
        return Err(unauthorized(
            "the runtime generation is no longer the active one",
        ));
    }
    let provider: String = job.get("provider");
    let capabilities: JsonValue = job.get("capabilities");
    if crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities) {
        return Err(forbidden(
            "rolling saves are only for provider-managed hosted runtimes",
        ));
    }
    let payload: JsonValue = job.get("payload");
    if !job_allows_workspace_mutation(&payload) {
        return Err(forbidden("this job is not allowed to write the workspace"));
    }
    let service_subject = state.config.service_runtime_user_id == Some(bound.subject_user);
    let payload_user = payload
        .get("user_id")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    if !service_subject && payload_user != Some(bound.subject_user) {
        return Err(unauthorized("the subject does not match the job"));
    }
    let project = load_project_record(&transaction, project_id).await?;
    ensure_project_write_access(
        &transaction,
        &project,
        &RequestContext {
            user_id: Some(bound.subject_user),
            is_service_role: service_subject,
            scoped_claims: None,
        },
        None,
    )
    .await?;
    let origin = transaction
        .query_opt(
            "select o.id, o.mode, o.endpoint, oi.endpoint as instance_endpoint
             from origin_instances oi
             join workspace_origins o
               on o.id = oi.origin_id
              and o.project_id = oi.project_id
             where oi.project_id = $1
               and oi.runtime_id = $2
               and oi.lease_id = $3
               and ($4::uuid is null or o.id = $4)
               and oi.status = 'online'
               and oi.mode in ('hosted', 'efs')
               and (cardinality(oi.protocols) = 0 or 'http' = any(oi.protocols))
             order by oi.updated_at desc
             limit 1",
            &[
                project_id,
                &bound.runtime_id,
                &bound.runtime_lease_id,
                &origin_id,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check a rolling save: {error}")))?
        .ok_or_else(|| unauthorized("the runtime's hosted origin is not online"))?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to check a rolling save: {error}")))?;
    let origin_endpoint = origin
        .get::<_, Option<String>>("instance_endpoint")
        .filter(|endpoint| !endpoint.trim().is_empty())
        .unwrap_or_else(|| origin.get("endpoint"));
    Ok(PersistJob {
        job_id: job.get("id"),
        origin_id: origin.get("id"),
        origin_mode: origin.get("mode"),
        origin_endpoint,
    })
}

/// `POST /access_token {scopes: ["workspace.persist"], jobId?}` with a job's
/// internal workspace token: the grant for one rolling save (see the module
/// docs).
pub(crate) async fn mint_persist_grant(
    state: &AppState,
    headers: &HeaderMap,
    context: &RequestContext,
    body: &AccessTokenRequest,
) -> ApiResult<Json<JsonValue>> {
    let project_id =
        Uuid::parse_str(body.project_id.trim()).map_err(|_| bad_request("projectId is invalid"))?;
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| forbidden("a rolling save's grant is minted for a job token only"))?;
    ensure_scoped_project_match(context, &project_id)?;
    let scopes: Vec<String> = body
        .scopes
        .iter()
        .map(|scope| scope.trim().to_ascii_lowercase())
        .filter(|scope| !scope.is_empty())
        .collect();
    if scopes.iter().any(|scope| scope != WORKSPACE_PERSIST_SCOPE) {
        return Err(bad_request(
            "workspace.persist must be requested on its own",
        ));
    }
    if body
        .protocol
        .as_deref()
        .is_some_and(|protocol| !protocol.trim().eq_ignore_ascii_case("http"))
    {
        return Err(bad_request("a rolling save's grant is for http"));
    }
    if body.origin_id.is_some()
        || body.prefer_hosted == Some(true)
        || body.lease_id.is_some()
        || body.browser_session_id.is_some()
    {
        return Err(forbidden(
            "job tokens cannot override workspace origin selection",
        ));
    }
    if !claims
        .scopes
        .iter()
        .any(|scope| scope == JOB_ORIGIN_TOKEN_MINT_SCOPE)
    {
        return Err(forbidden("job token is missing the required capability"));
    }
    if !state.config.working_state_saves {
        return Err(rolling_saves_off());
    }
    let bound = bound(claims, "job token")?;
    if claims.aud.trim() != bound.runtime_id.to_string() {
        return Err(unauthorized("job token audience mismatch"));
    }
    let preferred = parse_optional_uuid_param(body.prefer_runtime.clone(), "preferRuntime")?;
    if preferred.is_some_and(|runtime_id| runtime_id != bound.runtime_id) {
        return Err(forbidden("preferred runtime does not match the active job"));
    }
    let job_id = parse_optional_uuid_param(body.job_id.clone(), "jobId")?;
    let job = load_persist_job(state, &project_id, &bound, job_id, None).await?;
    if state.config.origin_token_private_key.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("origin token signing key not configured")),
        ));
    }
    let scopes = vec![WORKSPACE_PERSIST_SCOPE.to_string()];
    let minted = mint_scoped_token_expires_no_later_than(
        &state.config,
        ScopedTokenRequest {
            audience: job.origin_id.to_string(),
            subject: bound.subject_user.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(job.origin_id.to_string()),
            runtime_id: Some(bound.runtime_id.to_string()),
            protocol: Some("http".to_string()),
            scopes: scopes.clone(),
            lease_id: Some(bound.runtime_lease_id.to_string()),
            run_id: Some(bound.run_id.to_string()),
            prefer_runtime: None,
            ttl_seconds: Some(GRANT_TTL_SECONDS),
        },
        Utc::now() + chrono::Duration::seconds(GRANT_TTL_SECONDS),
    )?;
    record_access_grant(
        &state.pool,
        &project_id,
        &job.origin_id,
        Some(&bound.subject_user),
        None,
        &scopes,
        "http",
        minted.issued_at,
        minted.expires_at,
        Some(&minted.jti),
        None,
        None,
    )
    .await
    .map_err(|error| internal_error(format!("failed to record access grant: {error}")))?;
    Ok(Json(json!({
        "originId": job.origin_id,
        "mode": job.origin_mode,
        "endpoint": origin_endpoint_for_client(
            &state.config,
            headers,
            &job.origin_id,
            &job.origin_endpoint,
        ),
        "token": minted.token,
        "expiresIn": minted.ttl,
        "scopes": scopes,
        "leaseId": JsonValue::Null,
        "jobId": job.job_id,
    })))
}

/// Check a rolling save's grant the origin presents to mint `git.write`:
/// exactly [`WORKSPACE_PERSIST_SCOPE`] for this project and origin, whose
/// job, runtime generation, online origin and user's write access all
/// still hold (see the module docs). The git token never outlives it.
pub(super) async fn authorize_persist_grant(
    state: &AppState,
    context: &RequestContext,
    project_id: &Uuid,
) -> ApiResult<ScopedGitMintContext> {
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("a rolling save's grant is required"))?;
    ensure_scoped_project_match(context, project_id)?;
    if claims.scopes.len() != 1 || claims.scopes[0] != WORKSPACE_PERSIST_SCOPE {
        return Err(forbidden(
            "a rolling save's grant carries its scope and nothing else",
        ));
    }
    if claims.protocol.as_deref() != Some("http") {
        return Err(forbidden("the grant's protocol is invalid"));
    }
    let origin_id = parse_claim(claims.origin_id.as_deref(), "grant origin")?;
    if claims.aud.trim() != origin_id.to_string() {
        return Err(unauthorized("the grant's audience is invalid"));
    }
    let bound = bound(claims, "grant")?;
    let expires_at = DateTime::<Utc>::from_timestamp(claims.exp, 0)
        .ok_or_else(|| unauthorized("the grant's expiry is invalid"))?;
    if !state.config.working_state_saves {
        return Err(rolling_saves_off());
    }
    let job = load_persist_job(state, project_id, &bound, None, Some(origin_id)).await?;
    info!(
        project_id = %project_id,
        runtime_id = %bound.runtime_id,
        origin_id = %origin_id,
        job_id = %job.job_id,
        "a rolling save's grant was exchanged for git access"
    );
    Ok(ScopedGitMintContext {
        subject: bound.subject_user.to_string(),
        runtime_id: Some(bound.runtime_id),
        lease_id: None,
        run_id: Some(bound.run_id),
        latest_expires_at: Some(expires_at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_persist_scope_asks_for_the_grant() {
        assert!(requests_persist_grant(&[" Workspace.Persist ".to_string()]));
        assert!(!requests_persist_grant(&["fs.write".to_string()]));
        assert!(!requests_persist_grant(&[
            crate::runtime::PRE_STOP_SAVE_SCOPE.to_string()
        ]));
    }

    #[test]
    fn the_switch_answers_with_a_fixed_code() {
        let (status, Json(body)) = rolling_saves_off();
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body.code.as_deref(), Some(ROLLING_SAVES_OFF_CODE));
    }

    #[test]
    fn healthz_advertises_rolling_saves() {
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-origin-key",
        );
        assert_eq!(
            working_state_header(&config),
            (
                "x-instafy-working-state",
                axum::http::HeaderValue::from_static("1")
            )
        );
        config.working_state_saves = false;
        assert_eq!(
            working_state_header(&config).1,
            axum::http::HeaderValue::from_static("0")
        );
        let main = include_str!("../main.rs");
        assert!(
            main.contains("origins::workspace_persist::working_state_header(&state.config)"),
            "/healthz sends the header"
        );
    }

    #[test]
    fn the_origin_names_the_same_scope() {
        let origin = include_str!("../../../origin-http-server/src/routes.rs");
        assert!(origin.contains(&format!(
            "pub const WORKSPACE_PERSIST_SCOPE: &str = \"{WORKSPACE_PERSIST_SCOPE}\";"
        )));
    }
}
