use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use runtime_contracts::AccessTokenClaims;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tracing::instrument;
use uuid::Uuid;

use crate::auth::authenticate_request;
#[cfg(test)]
use crate::ensure_scoped_claims_allow_requested_scopes;
use crate::tokens::{
    mint_scoped_token_with_runtime_generation, MintedAccessToken, ScopedTokenRequest,
};
use crate::{
    bad_request, ensure_project_write_access, forbidden, internal_error, load_project_record,
    parse_optional_uuid_param, unauthorized, ApiError, AppState,
};

/// Stable minimum accepted from already-issued runtime tokens. Keep this
/// separate from the minted defaults so rolling deploys do not reject tokens
/// created by the previous controller version. This is also the identifying
/// baseline used to recognise a full runtime-machine mint (below); the
/// additive Git/telemetry capabilities are not part of that identity.
pub(crate) const RUNTIME_TOKEN_REQUIRED_SCOPES: &[&str] = &[
    "agent.lease",
    "agent.heartbeat",
    "agent.message",
    "agent.complete",
    "agent.stop",
    "origin.register",
    "origin.presence",
    "origin.apply",
];
/// Capabilities granted to newly minted runtime tokens. The bundled origin
/// server uses the runtime token to obtain short-lived, project-bound Git
/// credentials for checkout and canonical sync; explicit Git scopes preserve
/// monotonic delegation at that token-minting boundary.
pub(crate) const RUNTIME_TOKEN_DEFAULT_SCOPES: &[&str] = &[
    "agent.lease",
    "agent.heartbeat",
    "agent.message",
    "agent.complete",
    "agent.stop",
    "origin.register",
    "origin.presence",
    "origin.apply",
    "git.read",
    "git.write",
];
pub(crate) const RUNTIME_TOKEN_TELEMETRY_SCOPE: &str = "telemetry.write";
pub(crate) const RUNTIME_TOKEN_GIT_MINT_SCOPE: &str = "git.token.mint";
pub(crate) const RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE: &str = "workspace.lease.read";
pub(crate) const PERSONAL_BROWSER_RUNTIME_SCOPE: &str = "personal_browser.control";
pub(crate) const RUNTIME_TOKEN_GENERATION_CAPABILITY: &str = "_instafyRuntimeTokenGeneration";
/// Scopes that a user or service caller may request from the public runtime
/// token endpoint. Agent-only capabilities such as `agent.secrets` and
/// `agent.browser_profile` are issued only after controller-authorized runtime
/// registration and must not be self-selected here.
const RUNTIME_TOKEN_ALLOWED_SCOPES: &[&str] = &[
    "agent.lease",
    "agent.heartbeat",
    "agent.message",
    "agent.complete",
    "agent.stop",
    "origin.register",
    "origin.presence",
    "origin.apply",
    "git.read",
    "git.write",
    RUNTIME_TOKEN_TELEMETRY_SCOPE,
    RUNTIME_TOKEN_GIT_MINT_SCOPE,
    RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE,
    PERSONAL_BROWSER_RUNTIME_SCOPE,
];

const DEFAULT_RUNTIME_TOKEN_TTL_SECONDS: i64 = 3600;
const MAX_RUNTIME_TOKEN_TTL_SECONDS: i64 = 3600;
const MIN_RUNTIME_TOKEN_TTL_SECONDS: i64 = 60;

/// Scopes issued to new and renewed runtime tokens.
///
/// `RUNTIME_TOKEN_REQUIRED_SCOPES` remains the compatibility baseline used to
/// authenticate tokens minted before telemetry writes were introduced. Keeping
/// issuance additive avoids disconnecting already-running production agents.
/// The Git checkout/sync scopes are part of the minted defaults
/// (`RUNTIME_TOKEN_DEFAULT_SCOPES`); the telemetry, Git-mint and
/// workspace-lease-read capabilities are chained on top.
pub(crate) fn default_runtime_token_scopes() -> Vec<String> {
    RUNTIME_TOKEN_DEFAULT_SCOPES
        .iter()
        .copied()
        .chain([
            RUNTIME_TOKEN_TELEMETRY_SCOPE,
            RUNTIME_TOKEN_GIT_MINT_SCOPE,
            RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE,
        ])
        .map(str::to_string)
        .collect()
}

/// Normalize, deduplicate and allowlist a caller-requested runtime-token scope
/// set. The personal browser control scope may only be granted with an
/// explicit `personalBrowser=true`.
fn normalize_runtime_token_scopes(
    requested: Option<Vec<String>>,
    personal_browser: bool,
) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let mut scopes = match requested {
        Some(list) if list.is_empty() => return Err(bad_request("scopes must not be empty")),
        Some(list) => list,
        None => default_runtime_token_scopes(),
    };
    scopes = scopes
        .into_iter()
        .map(|scope| scope.trim().to_ascii_lowercase())
        .filter(|scope| !scope.is_empty())
        .collect();
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() {
        return Err(bad_request("scopes must not be empty"));
    }
    if scopes
        .iter()
        .any(|scope| !RUNTIME_TOKEN_ALLOWED_SCOPES.contains(&scope.as_str()))
    {
        return Err(bad_request("unsupported runtime token scope requested"));
    }
    if scopes
        .iter()
        .any(|scope| scope == PERSONAL_BROWSER_RUNTIME_SCOPE)
        && !personal_browser
    {
        return Err(bad_request(
            "personal_browser.control requires personalBrowser=true",
        ));
    }
    add_personal_browser_scope(&mut scopes, personal_browser);
    scopes.sort();
    Ok(scopes)
}

/// Clamp a requested runtime-token TTL to the hard bounds and to any remaining
/// lifetime delegated by a scoped parent token. A runtime token must never
/// outlive the credential that authorized it.
fn resolve_runtime_token_ttl(
    requested: Option<i64>,
    delegated_limit: Option<i64>,
) -> Result<i64, (StatusCode, Json<ApiError>)> {
    if let Some(value) = requested {
        if !(MIN_RUNTIME_TOKEN_TTL_SECONDS..=MAX_RUNTIME_TOKEN_TTL_SECONDS).contains(&value) {
            return Err(bad_request(format!(
                "ttlSeconds must be between {MIN_RUNTIME_TOKEN_TTL_SECONDS} and {MAX_RUNTIME_TOKEN_TTL_SECONDS}"
            )));
        }
    }
    let limit = delegated_limit
        .unwrap_or(MAX_RUNTIME_TOKEN_TTL_SECONDS)
        .min(MAX_RUNTIME_TOKEN_TTL_SECONDS);
    if limit < MIN_RUNTIME_TOKEN_TTL_SECONDS {
        return Err(forbidden(
            "Parent access token expires too soon to mint a runtime token",
        ));
    }
    let ttl = requested.unwrap_or(DEFAULT_RUNTIME_TOKEN_TTL_SECONDS.min(limit));
    if ttl > limit {
        return Err(forbidden(
            "Runtime token cannot outlive the scoped access token",
        ));
    }
    Ok(ttl)
}

/// Ensure a scoped parent token does not silently widen its identity bounds
/// when re-minting a runtime token. An origin-bound parent may not mint a
/// runtime token, and a runtime/lease-bound parent may not change its binding.
fn ensure_scoped_runtime_binding(
    context: &crate::auth::RequestContext,
    runtime_id: Option<uuid::Uuid>,
    lease_id: Option<uuid::Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(claims) = context.scoped_claims.as_ref() else {
        return Ok(());
    };
    // This endpoint always mints a runtime token (`origin_id = None`) and may
    // change the audience to the requested runtime. Allowing an origin-bound
    // parent through would silently discard both of those identity bounds.
    if claims.origin_id.is_some() {
        return Err(forbidden(
            "An origin-scoped token cannot mint runtime access tokens",
        ));
    }
    if let Some(parent_runtime) = claims.runtime_id.as_deref() {
        let parent_runtime = uuid::Uuid::parse_str(parent_runtime.trim())
            .map_err(|_| forbidden("Parent access token has an invalid runtime scope"))?;
        if runtime_id != Some(parent_runtime) {
            return Err(forbidden(
                "A runtime-scoped token cannot change or remove its runtime binding",
            ));
        }
    }
    if let Some(parent_lease) = claims.lease_id.as_deref() {
        let parent_lease = uuid::Uuid::parse_str(parent_lease.trim())
            .map_err(|_| forbidden("Parent access token has an invalid lease scope"))?;
        if lease_id != Some(parent_lease) {
            return Err(forbidden(
                "A lease-scoped token cannot change or remove its lease binding",
            ));
        }
    }
    Ok(())
}

pub(crate) fn runtime_generation_from_capabilities(
    capabilities: &JsonValue,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(raw) = capabilities.get(RUNTIME_TOKEN_GENERATION_CAPABILITY) else {
        return Ok(None);
    };
    let value = raw
        .as_str()
        .ok_or_else(|| unauthorized("persisted runtime token generation is invalid"))?;
    Uuid::parse_str(value.trim())
        .map(Some)
        .map_err(|_| unauthorized("persisted runtime token generation is invalid"))
}

pub(crate) fn signed_runtime_generation(
    claims: &AccessTokenClaims,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    claims
        .runtime_generation
        .as_deref()
        .map(|value| {
            Uuid::parse_str(value.trim())
                .map_err(|_| unauthorized("runtime token generation scope is invalid"))
        })
        .transpose()
}

/// Resolve the stable self-hosted generation carried by a runtime token.
///
/// Tokens minted before the dedicated claim shipped use their UUID JTI as the
/// generation. Registration persists that value, so a lost renewal response
/// remains retryable without allowing the legacy credential to cross a later
/// human-authorized successor generation.
pub(crate) fn effective_runtime_generation(
    claims: &AccessTokenClaims,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    if let Some(generation) = signed_runtime_generation(claims)? {
        return Ok(generation);
    }
    Uuid::parse_str(claims.jti.trim())
        .map_err(|_| unauthorized("legacy runtime token generation is invalid"))
}

pub(crate) fn set_runtime_generation_capability(capabilities: &mut JsonValue, generation: Uuid) {
    if !capabilities.is_object() {
        *capabilities = JsonValue::Object(serde_json::Map::new());
    }
    if let Some(map) = capabilities.as_object_mut() {
        map.insert(
            RUNTIME_TOKEN_GENERATION_CAPABILITY.to_string(),
            JsonValue::String(generation.to_string()),
        );
    }
}

pub(crate) fn ensure_runtime_generation_matches(
    capabilities: &JsonValue,
    claims: &AccessTokenClaims,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let presented = effective_runtime_generation(claims)?;
    if let Some(current) = runtime_generation_from_capabilities(capabilities)? {
        if presented != current {
            return Err(unauthorized(
                "runtime token generation is no longer current",
            ));
        }
        return Ok(Some(current));
    }
    Ok(None)
}

/// Validate an already-bound agent/job credential. Unlike runtime bootstrap
/// tokens, these credentials do not receive the legacy-JTI upgrade: an
/// unmarked token is valid only while the runtime itself has no marker.
pub(crate) fn ensure_bound_runtime_generation_matches(
    capabilities: &JsonValue,
    token_generation: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let current = runtime_generation_from_capabilities(capabilities)?;
    if token_generation != current {
        return Err(unauthorized(
            "runtime token generation is no longer current",
        ));
    }
    Ok(())
}

fn add_personal_browser_scope(scopes: &mut Vec<String>, requested: bool) {
    if requested
        && !scopes
            .iter()
            .any(|scope| scope == PERSONAL_BROWSER_RUNTIME_SCOPE)
    {
        scopes.push(PERSONAL_BROWSER_RUNTIME_SCOPE.to_string());
    }
}

fn runtime_token_subject(
    is_service_role: bool,
    authenticated_subject: String,
    requested_subject: Option<String>,
) -> String {
    if is_service_role {
        requested_subject.unwrap_or(authenticated_subject)
    } else {
        authenticated_subject
    }
}

fn service_runtime_token_subject(service_runtime_user_id: Option<uuid::Uuid>) -> String {
    service_runtime_user_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "runtime.service".to_string())
}

fn existing_runtime_token_owner_is_authorized(
    capabilities: &JsonValue,
    requested_owner: Option<uuid::Uuid>,
    requests_personal_browser: bool,
    is_private_self_hosted: bool,
) -> bool {
    if is_private_self_hosted {
        return super::access::self_hosted_owner_user_id(capabilities)
            .is_some_and(|existing_owner| requested_owner == Some(existing_owner));
    }
    !requests_personal_browser
}

#[derive(Debug, Deserialize)]
pub(crate) struct RuntimeTokenPathParams {
    pub(crate) project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeTokenRequest {
    #[serde(default)]
    pub(crate) scopes: Option<Vec<String>>,
    #[serde(default, rename = "runtimeId")]
    pub(crate) runtime_id: Option<String>,
    #[serde(default, rename = "leaseId")]
    pub(crate) lease_id: Option<String>,
    #[serde(default)]
    pub(crate) ttl_seconds: Option<i64>,
    #[serde(default)]
    pub(crate) subject: Option<String>,
    #[serde(default, rename = "personalBrowser", alias = "personal_browser")]
    pub(crate) personal_browser: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeTokenResponse {
    pub(crate) token: String,
    pub(crate) scopes: Vec<String>,
    pub(crate) expires_at: String,
    pub(crate) expires_in: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) git_remote_url: Option<String>,
}

#[instrument(skip_all)]
pub(super) async fn mint_runtime_access_token(
    State(state): State<AppState>,
    Path(params): Path<RuntimeTokenPathParams>,
    headers: HeaderMap,
    Json(body): Json<RuntimeTokenRequest>,
) -> Result<Json<RuntimeTokenResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    // Shipped production behavior (shared-browser collaboration): a scoped
    // access token may never mint a runtime access token. Runtime tokens carry
    // the machine-identity, lease and self-hosted generation bounds that a
    // delegated scoped credential must not be able to originate.
    if context.scoped_claims.is_some() {
        return Err(crate::forbidden(
            "Scoped access tokens cannot mint runtime access tokens",
        ));
    }
    let project_id = parse_optional_uuid_param(Some(params.project_id), "projectId")?
        .ok_or_else(|| bad_request("projectId is required"))?;
    let requested_runtime_id = parse_optional_uuid_param(body.runtime_id.clone(), "runtimeId")?;
    let lease_id = parse_optional_uuid_param(body.lease_id.clone(), "leaseId")?;
    if lease_id.is_some() && requested_runtime_id.is_none() {
        return Err(bad_request("runtimeId is required for a lease-bound token"));
    }
    if lease_id.is_some() && !context.is_service_role {
        return Err(crate::forbidden(
            "Lease-bound runtime tokens may only be issued by controller service automation",
        ));
    }

    let authenticated_subject = match context.user_id {
        Some(user) => user.to_string(),
        None => state
            .config
            .service_runtime_user_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "runtime.cli".to_string()),
    };
    // A normal project member must never choose another user's runtime-token
    // subject: registration uses this signed subject to attest ownership of
    // device-local Personal Browser capability. Service automation retains
    // the legacy descriptive-subject override.
    let subject = if lease_id.is_some() {
        // Registration treats this subject as the controller's attestation
        // that a provider-managed lease may mint an agent token. Do not retain
        // the descriptive service-subject override on this privileged path.
        service_runtime_token_subject(state.config.service_runtime_user_id)
    } else {
        runtime_token_subject(
            context.is_service_role,
            authenticated_subject,
            body.subject.clone(),
        )
    };

    let scopes = normalize_runtime_token_scopes(body.scopes, body.personal_browser)?;
    // A human/service mint is the authoritative self-hosted generation
    // rotation boundary. Registration renewals preserve this value. Identity is
    // recognised by the required baseline agent scopes only; the additive
    // Git/telemetry capabilities are not part of the machine-mint signature.
    let mints_runtime_machine = RUNTIME_TOKEN_REQUIRED_SCOPES
        .iter()
        .all(|required| scopes.iter().any(|scope| scope == required));
    // Every candidate-less self-hosted process gets a fresh,
    // controller-chosen identity, including trusted local smoke/service
    // launchers. A project-scoped user token used to let registration reuse a
    // caller-chosen UUID, which could silently bind the wrong machine or
    // preclaim another project's deterministic hosted origin identity.
    // Provider-managed lease tokens already carry a runtime ID.
    let unleased_runtime_machine_mint = lease_id.is_none() && mints_runtime_machine;
    let human_runtime_machine_mint = !context.is_service_role && unleased_runtime_machine_mint;
    let runtime_id =
        requested_runtime_id.or_else(|| unleased_runtime_machine_mint.then(Uuid::new_v4));
    let audience = runtime_id
        .as_ref()
        .map(|id| id.to_string())
        .unwrap_or_else(|| project_id.to_string());
    let ttl_seconds = resolve_runtime_token_ttl(body.ttl_seconds, None)?;
    let successor_generation = (lease_id.is_none() && mints_runtime_machine).then(Uuid::new_v4);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start project lookup: {error}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, None).await?;
    let mut successor_capabilities = None;
    if let Some(runtime_id) = runtime_id {
        let existing = transaction
            .query_opt(
                "select provider, active_lease_id, capabilities
                 from runtimes
                 where project_id = $1 and id = $2
                 for update",
                &[&project_id, &runtime_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to validate existing Personal Browser runtime token owner: {error}"
                ))
            })?;
        if let Some(existing) = existing {
            let provider: String = existing.get("provider");
            let active_lease_id: Option<uuid::Uuid> = existing.get("active_lease_id");
            let capabilities: JsonValue = existing.get("capabilities");
            if !context.is_service_role
                && (!super::access::runtime_is_private_self_hosted(
                    &state,
                    &provider,
                    &capabilities,
                ) || active_lease_id.is_some())
            {
                return Err(crate::forbidden(
                    "Existing hosted runtime tokens may only be issued by controller service automation",
                ));
            }
            if let Some(requested_lease_id) = lease_id {
                if active_lease_id != Some(requested_lease_id) {
                    return Err(crate::forbidden(
                        "Lease-bound runtime token does not match the active runtime generation",
                    ));
                }
            }
            let requested_owner = uuid::Uuid::parse_str(subject.trim()).ok();
            if !context.is_service_role
                && !existing_runtime_token_owner_is_authorized(
                    &capabilities,
                    requested_owner,
                    body.personal_browser,
                    super::access::runtime_is_private_self_hosted(&state, &provider, &capabilities),
                )
            {
                return Err(crate::forbidden(
                    "Existing self-hosted runtime is private to a different owner",
                ));
            }
            if super::access::runtime_is_private_self_hosted(&state, &provider, &capabilities)
                && successor_generation.is_some()
            {
                successor_capabilities = Some(capabilities);
            }
        } else if human_runtime_machine_mint && requested_runtime_id == Some(runtime_id) {
            // Human-started machines receive a controller-generated identity.
            // A caller-supplied UUID is accepted only to rotate/reconnect an
            // existing private runtime owned by that same authenticated user;
            // otherwise it could preclaim another controller-derived identity
            // (including a future project's hosted origin UUID).
            return Err(crate::forbidden(
                "A new self-hosted runtime id must be generated by the controller",
            ));
        }
    }

    let minted = mint_scoped_token_with_runtime_generation(
        &state.config,
        ScopedTokenRequest {
            audience,
            subject,
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: runtime_id.map(|id| id.to_string()),
            protocol: None,
            scopes: scopes.clone(),
            lease_id: lease_id.map(|id| id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(ttl_seconds),
        },
        successor_generation,
    )?;

    if let (Some(mut capabilities), Some(generation), Some(runtime_id)) =
        (successor_capabilities, successor_generation, runtime_id)
    {
        set_runtime_generation_capability(&mut capabilities, generation);
        transaction
            .execute(
                "update runtimes
                 set capabilities = $3,
                     updated_at = now()
                 where project_id = $1 and id = $2",
                &[&project_id, &runtime_id, &capabilities],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to persist successor runtime token generation: {error}"
                ))
            })?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit project lookup: {error}")))?;

    let MintedAccessToken {
        token,
        expires_at,
        ttl,
        scopes,
        ..
    } = minted;

    // Only advertise a remote that is reachable from outside the cluster network;
    // GIT_REMOTE_BASE_URL may be a cluster-internal host (e.g. git-edge) that
    // Desktop/CLI runtimes cannot resolve.
    let git_remote_url = state
        .config
        .git_remote_public_base_url
        .as_deref()
        .map(|base| format!("{base}/{project_id}.git"));

    Ok(Json(RuntimeTokenResponse {
        token,
        scopes,
        expires_at: expires_at.to_rfc3339(),
        expires_in: ttl,
        runtime_id,
        git_remote_url,
    }))
}

#[cfg(test)]
#[path = "token_ttl_tests.rs"]
mod ttl_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn runtime_claims(jti: Uuid, generation: Option<Uuid>) -> AccessTokenClaims {
        AccessTokenClaims {
            aud: "runtime".to_string(),
            sub: "runtime.service".to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: None,
            runtime_id: Some(Uuid::new_v4().to_string()),
            protocol: None,
            scopes: default_runtime_token_scopes(),
            lease_id: None,
            runtime_generation: generation.map(|value| value.to_string()),
            run_id: None,
            iat: 1,
            exp: i64::MAX,
            jti: jti.to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        }
    }

    fn scoped_context(scopes: &[&str]) -> crate::auth::RequestContext {
        let now = chrono::Utc::now().timestamp();
        crate::auth::RequestContext {
            user_id: Some(Uuid::new_v4()),
            is_service_role: false,
            scoped_claims: Some(AccessTokenClaims {
                aud: Uuid::new_v4().to_string(),
                sub: Uuid::new_v4().to_string(),
                project_id: Uuid::new_v4().to_string(),
                origin_id: None,
                runtime_id: None,
                protocol: None,
                scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
                lease_id: None,
                runtime_generation: None,
                run_id: None,
                iat: now,
                exp: now + 300,
                jti: Uuid::new_v4().to_string(),
                prefer_runtime: None,
                actor_label: None,
                browser_session_id: None,
            }),
        }
    }

    #[test]
    fn default_runtime_tokens_include_additive_machine_capabilities() {
        let scopes = default_runtime_token_scopes();
        for capability in [
            RUNTIME_TOKEN_TELEMETRY_SCOPE,
            RUNTIME_TOKEN_GIT_MINT_SCOPE,
            RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE,
        ] {
            assert!(scopes.iter().any(|scope| scope == capability));
            assert!(!RUNTIME_TOKEN_DEFAULT_SCOPES.contains(&capability));
        }
    }

    #[test]
    fn runtime_token_scope_allowlist_rejects_unknown_or_implicit_personal_scope() {
        assert!(normalize_runtime_token_scopes(Some(Vec::new()), false).is_err());
        assert!(normalize_runtime_token_scopes(Some(vec!["   ".to_string()]), false).is_err());
        assert!(
            normalize_runtime_token_scopes(Some(vec!["admin.everything".to_string()]), false)
                .is_err()
        );
        assert!(normalize_runtime_token_scopes(
            Some(vec![PERSONAL_BROWSER_RUNTIME_SCOPE.to_string()]),
            false
        )
        .is_err());

        let scopes = normalize_runtime_token_scopes(
            Some(vec![
                " origin.presence ".to_string(),
                "origin.presence".to_string(),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(scopes, vec!["origin.presence"]);

        let default_scopes = normalize_runtime_token_scopes(None, false).unwrap();
        assert!(default_scopes.iter().any(|scope| scope == "git.read"));
        assert!(default_scopes.iter().any(|scope| scope == "git.write"));
        assert!(!RUNTIME_TOKEN_REQUIRED_SCOPES.contains(&"git.read"));
        assert!(!RUNTIME_TOKEN_REQUIRED_SCOPES.contains(&"git.write"));
    }

    #[test]
    fn runtime_token_ttl_is_strictly_bounded_and_cannot_outlive_parent() {
        assert!(resolve_runtime_token_ttl(Some(59), None).is_err());
        assert!(resolve_runtime_token_ttl(Some(3_601), None).is_err());
        assert!(resolve_runtime_token_ttl(Some(301), Some(300)).is_err());
        assert_eq!(resolve_runtime_token_ttl(None, Some(300)).unwrap(), 300);
        assert_eq!(resolve_runtime_token_ttl(Some(600), None).unwrap(), 600);
    }

    #[test]
    fn scoped_runtime_token_cannot_escalate_capabilities() {
        let context = scoped_context(&["origin.presence"]);
        assert!(ensure_scoped_claims_allow_requested_scopes(
            &context,
            &["origin.presence".to_string()]
        )
        .is_ok());
        assert!(ensure_scoped_claims_allow_requested_scopes(
            &context,
            &["origin.apply".to_string()]
        )
        .is_err());

        let mut origin_bound = context;
        let origin_id = Uuid::new_v4();
        let claims = origin_bound.scoped_claims.as_mut().unwrap();
        claims.origin_id = Some(origin_id.to_string());
        claims.aud = origin_id.to_string();
        assert!(ensure_scoped_runtime_binding(&origin_bound, None, None).is_err());
    }

    #[test]
    fn personal_browser_scope_is_explicit_and_deduplicated() {
        let mut scopes = vec!["agent.lease".to_string()];
        add_personal_browser_scope(&mut scopes, false);
        assert!(!scopes
            .iter()
            .any(|scope| scope == PERSONAL_BROWSER_RUNTIME_SCOPE));

        add_personal_browser_scope(&mut scopes, true);
        add_personal_browser_scope(&mut scopes, true);
        assert_eq!(
            scopes
                .iter()
                .filter(|scope| scope.as_str() == PERSONAL_BROWSER_RUNTIME_SCOPE)
                .count(),
            1
        );
    }

    #[test]
    fn project_members_cannot_override_their_signed_runtime_owner() {
        let authenticated = Uuid::new_v4().to_string();
        assert_eq!(
            runtime_token_subject(
                false,
                authenticated.clone(),
                Some(Uuid::new_v4().to_string())
            ),
            authenticated
        );
        assert_eq!(
            runtime_token_subject(true, "service".to_string(), Some("automation".to_string())),
            "automation"
        );
    }

    #[test]
    fn lease_bound_subject_is_always_controller_service_identity() {
        let service_runtime_user_id = Uuid::new_v4();
        assert_eq!(
            service_runtime_token_subject(Some(service_runtime_user_id)),
            service_runtime_user_id.to_string()
        );
        assert_eq!(service_runtime_token_subject(None), "runtime.service");
    }

    #[test]
    fn existing_self_hosted_owner_is_read_from_controller_capability() {
        let owner = Uuid::new_v4();
        assert_eq!(
            crate::runtime::self_hosted_owner_user_id(&serde_json::json!({
                "personalBrowser": {
                    "enabled": true,
                    "ownerUserId": owner.to_string(),
                }
            })),
            Some(owner)
        );
        assert_eq!(
            crate::runtime::self_hosted_owner_user_id(&serde_json::json!({ "agent": true })),
            None
        );

        let teammate = Uuid::new_v4();
        let personal = serde_json::json!({
            "personalBrowser": {
                "enabled": true,
                "ownerUserId": owner.to_string(),
            }
        });
        assert!(existing_runtime_token_owner_is_authorized(
            &personal,
            Some(owner),
            true,
            true,
        ));
        assert!(!existing_runtime_token_owner_is_authorized(
            &personal,
            Some(teammate),
            false,
            true,
        ));
        assert!(!existing_runtime_token_owner_is_authorized(
            &serde_json::json!({ "agent": true }),
            Some(owner),
            true,
            true,
        ));
        assert!(!existing_runtime_token_owner_is_authorized(
            &serde_json::json!({ "agent": true }),
            Some(owner),
            false,
            true,
        ));
    }

    #[test]
    fn legacy_registration_retry_and_renewal_share_one_stable_generation() {
        let legacy_jti = Uuid::new_v4();
        let legacy = runtime_claims(legacy_jti, None);
        let empty = serde_json::json!({ "agent": true });
        assert_eq!(
            ensure_runtime_generation_matches(&empty, &legacy)
                .expect("unfenced rolling-upgrade runtime should accept its current token"),
            None
        );

        let generation = effective_runtime_generation(&legacy).expect("legacy UUID jti");
        assert_eq!(generation, legacy_jti);
        let mut persisted = empty;
        set_runtime_generation_capability(&mut persisted, generation);

        // If the first renewal response is lost, the incoming legacy token is
        // still the same generation and can safely retry registration.
        assert_eq!(
            ensure_runtime_generation_matches(&persisted, &legacy)
                .expect("lost registration response must remain retryable"),
            Some(generation)
        );

        let renewed = runtime_claims(Uuid::new_v4(), Some(generation));
        assert_eq!(
            effective_runtime_generation(&renewed).expect("renewed generation"),
            generation
        );
        assert_eq!(
            ensure_runtime_generation_matches(&persisted, &renewed)
                .expect("renewed token should preserve the registration generation"),
            Some(generation)
        );
    }

    #[test]
    fn successor_generation_permanently_fences_old_registration_and_tunnel_tokens() {
        let old_generation = Uuid::new_v4();
        let old_legacy = runtime_claims(old_generation, None);
        let old_renewed = runtime_claims(Uuid::new_v4(), Some(old_generation));
        let successor_generation = Uuid::new_v4();
        let successor = runtime_claims(Uuid::new_v4(), Some(successor_generation));
        let mut capabilities = serde_json::json!({ "agent": true });
        set_runtime_generation_capability(&mut capabilities, successor_generation);

        // This shared validator runs before registration can overwrite
        // capabilities and before any runtime-machine tunnel operation.
        assert!(ensure_runtime_generation_matches(&capabilities, &old_legacy).is_err());
        assert!(ensure_runtime_generation_matches(&capabilities, &old_renewed).is_err());
        assert_eq!(
            ensure_runtime_generation_matches(&capabilities, &successor)
                .expect("current successor should retain tunnel authority"),
            Some(successor_generation)
        );
    }
}
