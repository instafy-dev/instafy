use std::str::FromStr;

use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use runtime_contracts::AccessTokenClaims;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::Transaction;
use tracing::{info, warn};
use uuid::Uuid;

use crate::auth::{
    authenticate_request, bearer_token, claims_have_scopes, issue_agent_token_for_runtime,
    issue_proxy_envelope,
};
use crate::tokens::{
    decode_scoped_token, mint_scoped_token_with_runtime_generation, ScopedTokenRequest,
};
use crate::{coerce_idle_ttl, forbidden, internal_error, load_project_record, unauthorized};
use crate::{ApiError, AppState};

use super::db::{
    ensure_project_exists, ensure_runtime_record, fetch_runtime_lease_for_update, map_runtime_row,
    mark_runtime_lease_active, record_runtime_event, RuntimeLeaseDetails,
};
use super::lease::parse_lease_scope;
use super::provider::authorize_provider_for_project;
use super::token::{
    default_runtime_token_scopes, effective_runtime_generation, ensure_runtime_generation_matches,
    set_runtime_generation_capability, PERSONAL_BROWSER_RUNTIME_SCOPE,
    RUNTIME_TOKEN_GENERATION_CAPABILITY, RUNTIME_TOKEN_REQUIRED_SCOPES,
};
use super::utils::normalize_display_name_owned;
#[cfg(test)]
use crate::runtime::RUNTIME_TOKEN_DEFAULT_SCOPES;

const RENEWED_RUNTIME_TOKEN_MIN_TTL_SECONDS: i64 = 3600;

#[derive(Debug)]
struct RuntimeRegistrationIdentity {
    lease_details: Option<RuntimeLeaseDetails>,
    runtime_id: Option<Uuid>,
}

fn registration_conflict(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::CONFLICT, Json(ApiError::new(message)))
}

fn resolve_registration_runtime_id(
    lease_runtime_id: Option<Uuid>,
    token_runtime_id: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    if let (Some(lease_runtime_id), Some(token_runtime_id)) = (lease_runtime_id, token_runtime_id) {
        if lease_runtime_id != token_runtime_id {
            return Err(unauthorized(
                "runtime token does not match the requested runtime lease",
            ));
        }
    }
    Ok(lease_runtime_id.or(token_runtime_id))
}

fn ensure_runtime_token_lease_matches_request(
    has_scoped_token: bool,
    token_lease_id: Option<Uuid>,
    requested_lease_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if has_scoped_token && token_lease_id != requested_lease_id {
        return Err(unauthorized(
            "runtime token lease scope does not match requested runtime lease",
        ));
    }
    Ok(())
}

/// Resolve and lock the rows that establish a runtime registration's identity.
///
/// Runtime lifecycle paths consistently lock `runtimes` before
/// `runtime_leases`. Registration must use the same order or a concurrent stop
/// can deadlock with it (stop owns runtime and waits for lease while register
/// owns lease and waits for runtime). The first lease read is deliberately
/// unlocked and is only an identity hint; after locking the runtime we lock the
/// exact lease and revalidate every identity field before proceeding.
async fn lock_runtime_registration_identity(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    lease_id: Option<Uuid>,
    runtime_id_from_token: Option<Uuid>,
    presented_self_hosted_owner: Option<Uuid>,
) -> Result<RuntimeRegistrationIdentity, (StatusCode, Json<ApiError>)> {
    let lease_hint = if let Some(lease_id) = lease_id {
        let row = transaction
            .query_opt(
                "select project_id, runtime_id
                 from runtime_leases
                 where id = $1",
                &[&lease_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to resolve runtime lease identity: {error}"))
            })?;
        let Some(row) = row else {
            return Err(crate::not_found("runtime lease not found"));
        };
        let lease_project_id: Uuid = row.get("project_id");
        if lease_project_id != *project_id {
            return Err(forbidden("runtime lease does not belong to project"));
        }
        Some(row.get::<_, Option<Uuid>>("runtime_id"))
    } else {
        None
    };

    let hinted_runtime_id =
        resolve_registration_runtime_id(lease_hint.flatten(), runtime_id_from_token)?;
    if lease_id.is_some() && hinted_runtime_id.is_none() {
        return Err(crate::bad_request(
            "runtime lease is not associated with a runtime",
        ));
    }

    // Runtime IDs are visible to project collaborators, so possession of an
    // arbitrary project-scoped token must not be enough to replace or clear a
    // Personal Browser owner's controller attestation. This is also the first
    // row lock in registration, matching stop/sweep lifecycle order.
    if let Some(runtime_id) = hinted_runtime_id {
        let existing = transaction
            .query_opt(
                "select provider, capabilities
                 from runtimes
                 where project_id = $1 and id = $2
                 for update",
                &[project_id, &runtime_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to lock existing runtime ownership: {error}"
                ))
            })?;
        if let Some(existing) = existing {
            let provider: String = existing.get("provider");
            let capabilities: JsonValue = existing.get("capabilities");
            if super::access::runtime_is_private_self_hosted(state, &provider, &capabilities)
                && !existing_self_hosted_owner_is_authorized(
                    &capabilities,
                    presented_self_hosted_owner,
                )
            {
                return Err(forbidden("Self-hosted runtime belongs to a different user"));
            }
            if !super::access::runtime_is_private_self_hosted(state, &provider, &capabilities)
                && presented_self_hosted_owner.is_some()
            {
                return Err(forbidden(
                    "Self-hosted runtime token cannot register a provider-managed runtime",
                ));
            }
        }
    }

    let lease_details = if let Some(lease_id) = lease_id {
        let lease = fetch_runtime_lease_for_update(transaction, &lease_id).await?;
        if lease.project_id != *project_id {
            return Err(forbidden("runtime lease does not belong to project"));
        }
        let locked_runtime_id =
            resolve_registration_runtime_id(lease.runtime_id, runtime_id_from_token)?;
        if locked_runtime_id != hinted_runtime_id {
            return Err(registration_conflict(
                "runtime lease identity changed during registration; retry",
            ));
        }
        Some(lease)
    } else {
        None
    };

    Ok(RuntimeRegistrationIdentity {
        lease_details,
        runtime_id: hinted_runtime_id,
    })
}

fn ensure_runtime_lease_is_registerable(
    lease: &RuntimeLeaseDetails,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if lease.released_at.is_some() {
        return Err(crate::bad_request(
            "runtime lease has already been released",
        ));
    }
    match lease.status.as_str() {
        "pending" | "launching" | "active" => Ok(()),
        "released" => Err(crate::bad_request(
            "runtime lease has already been released",
        )),
        "failed" => Err(crate::bad_request(
            "runtime lease failed to launch and cannot be registered",
        )),
        other => Err(crate::bad_request(format!(
            "runtime lease in state {other} cannot be registered"
        ))),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct RuntimeRegisterPayload {
    #[serde(rename = "projectId", alias = "project_id")]
    pub(crate) project_id: String,
    #[serde(default, rename = "runtimeId", alias = "runtime_id")]
    pub(crate) runtime_id: Option<String>,
    #[serde(default)]
    #[serde(
        rename = "provider",
        alias = "runtimeType",
        alias = "type",
        alias = "runtime_type"
    )]
    pub(crate) provider: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) capabilities: Option<JsonValue>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) endpoint_url: Option<String>,
    pub(crate) task_ref: Option<String>,
    #[serde(rename = "idleTtlSeconds", alias = "idle_ttl_seconds")]
    pub(crate) idle_ttl_seconds: Option<u32>,
    #[serde(rename = "displayName", alias = "display_name")]
    pub(crate) display_name: Option<String>,
    #[serde(rename = "leaseId", alias = "lease_id")]
    pub(crate) lease_id: Option<String>,
    #[serde(default, rename = "workspaceManifest", alias = "workspace_manifest")]
    pub(crate) workspace_manifest: Option<JsonValue>,
    #[serde(default, rename = "leaseScope", alias = "lease_scope")]
    pub(crate) lease_scope: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct RuntimeRegisterResponse {
    pub(crate) runtime_id: Uuid,
    pub(crate) agent_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_token_issued_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_token_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_token_scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_token_ttl: Option<i64>,
    pub(crate) lease_url: String,
    pub(crate) heartbeat_url: String,
    pub(crate) stop_url: Option<String>,
    #[serde(rename = "leaseId", skip_serializing_if = "Option::is_none")]
    pub(crate) lease_id: Option<Uuid>,
    pub(crate) proxy: Option<runtime_contracts::ProxyEnvelopePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_token: Option<String>,
}

fn attested_personal_browser_owner(
    claims: Option<&AccessTokenClaims>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(claims) = claims else {
        return Ok(None);
    };
    if !claims
        .scopes
        .iter()
        .any(|scope| scope == PERSONAL_BROWSER_RUNTIME_SCOPE)
    {
        return Ok(None);
    }
    Uuid::parse_str(claims.sub.trim()).map(Some).map_err(|_| {
        unauthorized("Personal Browser runtime token is missing its authenticated user owner")
    })
}

fn attest_runtime_capabilities(
    supplied: Option<JsonValue>,
    personal_browser_owner: Option<Uuid>,
    self_hosted_owner: Option<Uuid>,
    shared_browser_agent_consent: bool,
) -> JsonValue {
    let mut capabilities = match supplied {
        Some(JsonValue::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    // These keys are controller-owned. A runtime payload cannot self-assert a
    // Personal Browser or choose its owner without the signed token scope.
    capabilities.remove("personalBrowser");
    capabilities.remove("personal_browser");
    capabilities.remove(RUNTIME_TOKEN_GENERATION_CAPABILITY);
    capabilities.remove(super::managed::SHARED_BROWSER_AGENT_CONSENT_CAPABILITY);
    super::access::remove_self_hosted_access_attestation(&mut capabilities);
    if let Some(owner_user_id) = self_hosted_owner {
        super::access::set_self_hosted_access_attestation(&mut capabilities, owner_user_id);
    }
    if let Some(owner_user_id) = personal_browser_owner {
        capabilities.insert(
            "personalBrowser".to_string(),
            json!({
                "enabled": true,
                "ownerUserId": owner_user_id.to_string(),
            }),
        );
    }
    if shared_browser_agent_consent {
        capabilities.insert(
            super::managed::SHARED_BROWSER_AGENT_CONSENT_CAPABILITY.to_string(),
            json!({
                "version": super::managed::SHARED_BROWSER_AGENT_CONSENT_VERSION,
            }),
        );
    }
    JsonValue::Object(capabilities)
}

fn existing_self_hosted_owner_is_authorized(
    capabilities: &JsonValue,
    presented_owner: Option<Uuid>,
) -> bool {
    super::access::self_hosted_owner_user_id(capabilities)
        .is_some_and(|existing_owner| presented_owner == Some(existing_owner))
}

fn renewed_runtime_token_subject(
    self_hosted_owner: Option<Uuid>,
    service_runtime_user_id: Option<Uuid>,
) -> String {
    self_hosted_owner
        .or(service_runtime_user_id)
        .map(|id| id.to_string())
        .unwrap_or_else(|| "runtime.service".to_string())
}

fn attested_self_hosted_owner(
    provider_is_self_hosted: bool,
    claims: Option<&AccessTokenClaims>,
    fallback_context: Option<&crate::auth::RequestContext>,
    service_runtime_user_id: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    if !provider_is_self_hosted {
        return Ok(None);
    }

    if let Some(claims) = claims {
        if runtime_token_subject_is_controller_service(&claims.sub, service_runtime_user_id) {
            return service_runtime_user_id.map(Some).ok_or_else(|| {
                unauthorized("self-hosted service runtime is missing its controller identity")
            });
        }
        return Uuid::parse_str(claims.sub.trim()).map(Some).map_err(|_| {
            unauthorized("self-hosted runtime token is missing its authenticated user owner")
        });
    }

    let Some(context) = fallback_context else {
        return Err(unauthorized(
            "self-hosted runtime registration requires an authenticated owner",
        ));
    };
    if context.is_service_role {
        return service_runtime_user_id.map(Some).ok_or_else(|| {
            unauthorized("self-hosted service runtime is missing its controller identity")
        });
    }
    context.user_id.map(Some).ok_or_else(|| {
        unauthorized("self-hosted runtime registration requires an authenticated user owner")
    })
}

fn runtime_token_subject_is_controller_service(
    subject: &str,
    service_runtime_user_id: Option<Uuid>,
) -> bool {
    let subject = subject.trim();
    subject == "runtime.service"
        || service_runtime_user_id.is_some_and(|service_id| subject == service_id.to_string())
}

fn ensure_provider_managed_registration_is_controller_attested(
    provider_is_self_hosted: bool,
    scoped_claims: Option<&AccessTokenClaims>,
    service_runtime_user_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if provider_is_self_hosted {
        return Ok(());
    }
    let Some(claims) = scoped_claims else {
        // The only non-scoped fallback admitted by `runtime_register` is an
        // authenticated service role (or the explicit local dev fallback).
        return Ok(());
    };
    if runtime_token_subject_is_controller_service(&claims.sub, service_runtime_user_id) {
        return Ok(());
    }
    Err(unauthorized(
        "provider-managed runtime registration requires a controller-issued service token",
    ))
}

fn runtime_token_has_required_scopes(claims: &AccessTokenClaims) -> bool {
    claims_have_scopes(claims, RUNTIME_TOKEN_REQUIRED_SCOPES)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScopedRuntimeRegistrationBinding {
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
}

fn parse_scoped_binding_uuid(
    value: Option<&str>,
    label: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(unauthorized(format!(
            "runtime token has an invalid {label} binding"
        )));
    }
    Uuid::parse_str(value)
        .map(Some)
        .map_err(|_| unauthorized(format!("runtime token has an invalid {label} binding")))
}

fn validate_scoped_runtime_registration_binding(
    claims: &AccessTokenClaims,
    project_id: Uuid,
    requested_runtime_id: Option<Uuid>,
    requested_lease_id: Option<Uuid>,
) -> Result<ScopedRuntimeRegistrationBinding, (StatusCode, Json<ApiError>)> {
    let claimed_project_id = Uuid::parse_str(claims.project_id.trim())
        .map_err(|_| unauthorized("runtime token has an invalid project binding"))?;
    if claimed_project_id != project_id {
        return Err(unauthorized("runtime token project mismatch"));
    }
    if claims.origin_id.is_some() {
        return Err(unauthorized(
            "origin-scoped token cannot register a runtime",
        ));
    }

    let runtime_id = parse_scoped_binding_uuid(claims.runtime_id.as_deref(), "runtime")?;
    let lease_id = parse_scoped_binding_uuid(claims.lease_id.as_deref(), "lease")?;
    let audience = Uuid::parse_str(claims.aud.trim())
        .map_err(|_| unauthorized("runtime token has an invalid audience binding"))?;

    // Current runtime tokens are addressed to their runtime. Controllers
    // before the runtime-audience rollout addressed renewed, runtime-bound
    // tokens to the project instead. That legacy audience remains safe only
    // while the signed runtime_id below stays authoritative.
    let audience_matches = match runtime_id {
        Some(runtime_id) => audience == runtime_id || audience == project_id,
        None => audience == project_id,
    };
    if !audience_matches {
        return Err(unauthorized("runtime token audience mismatch"));
    }

    // A caller may omit runtimeId for compatibility with older runtime-agent
    // builds, but it may never override (or introduce) a signed binding.
    if requested_runtime_id.is_some() && requested_runtime_id != runtime_id {
        return Err(unauthorized("runtime token runtime mismatch"));
    }
    // Lease selection is security-sensitive and has no safe implicit upgrade:
    // a scoped caller must reproduce the signed lease binding exactly.
    if requested_lease_id != lease_id {
        return Err(unauthorized("runtime token lease mismatch"));
    }

    Ok(ScopedRuntimeRegistrationBinding {
        runtime_id,
        lease_id,
    })
}

fn validate_loaded_lease_binding(
    binding: ScopedRuntimeRegistrationBinding,
    loaded_lease_id: Uuid,
    loaded_runtime_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if binding.lease_id != Some(loaded_lease_id) {
        return Err(unauthorized(
            "runtime token does not match the selected runtime lease",
        ));
    }
    if let (Some(claimed_runtime_id), Some(loaded_runtime_id)) =
        (binding.runtime_id, loaded_runtime_id)
    {
        if claimed_runtime_id != loaded_runtime_id {
            return Err(unauthorized(
                "runtime token does not match the runtime lease binding",
            ));
        }
    }
    Ok(())
}

pub(crate) async fn runtime_register(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<RuntimeRegisterPayload>,
) -> Result<Json<RuntimeRegisterResponse>, (StatusCode, Json<ApiError>)> {
    let scoped_claims = match bearer_token(&headers) {
        Some(token) => match decode_scoped_token(&state.config, &token, "runtime token") {
            Ok(claims) => {
                if runtime_token_has_required_scopes(&claims) {
                    Some(claims)
                } else {
                    warn!(scopes = ?claims.scopes, "runtime token missing required scopes");
                    return Err(unauthorized(
                        "runtime token is missing required registration scopes",
                    ));
                }
            }
            Err((status, error)) => {
                warn!(
                    status = ?status,
                    message = %error.0.message,
                    "failed to decode scoped runtime token"
                );
                None
            }
        },
        None => None,
    };
    let personal_browser_owner = attested_personal_browser_owner(scoped_claims.as_ref())?;
    let auth_context = if scoped_claims.is_some() {
        None
    } else {
        // Fallback: allow service role (or dev mode) tokens to proceed, to keep local/dev stacks usable.
        let auth = authenticate_request(&state.config, &headers, None).await?;
        if !auth.is_service_role && !state.config.dev_mode {
            info!("runtime register missing scoped runtime token");
            return Err(unauthorized(
                "runtime register requires bearer token with agent/origin scopes",
            ));
        }
        Some(auth)
    };

    let project_id = Uuid::from_str(&payload.project_id)
        .map_err(|_| crate::bad_request("project_id must be a valid UUID"))?;
    let requested_runtime_id = payload
        .runtime_id
        .as_deref()
        .map(|value| {
            Uuid::from_str(value).map_err(|_| crate::bad_request("runtimeId must be a valid UUID"))
        })
        .transpose()?;
    let lease_id = payload
        .lease_id
        .as_deref()
        .map(|value| {
            Uuid::from_str(value).map_err(|_| crate::bad_request("leaseId must be a valid UUID"))
        })
        .transpose()?;
    let scoped_binding = scoped_claims
        .as_ref()
        .map(|claims| {
            validate_scoped_runtime_registration_binding(
                claims,
                project_id,
                requested_runtime_id,
                lease_id,
            )
        })
        .transpose()?;
    let runtime_id_from_token = scoped_binding.and_then(|binding| binding.runtime_id);
    info!(
        project_id = %project_id,
        has_runtime_id = runtime_id_from_token.is_some(),
        "runtime register request received"
    );
    let runtime_provider = payload
        .provider
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.provider_registry.default_provider_id());
    let runtime_provider_is_self_hosted =
        super::provider::provider_is_self_hosted(&state, &runtime_provider);
    ensure_provider_managed_registration_is_controller_attested(
        runtime_provider_is_self_hosted,
        scoped_claims.as_ref(),
        state.config.service_runtime_user_id,
    )?;
    let self_hosted_owner = attested_self_hosted_owner(
        runtime_provider_is_self_hosted,
        scoped_claims.as_ref(),
        auth_context.as_ref(),
        state.config.service_runtime_user_id,
    )?;
    if let Some(personal_browser_owner) = personal_browser_owner {
        if self_hosted_owner != Some(personal_browser_owner) {
            return Err(unauthorized(
                "Personal Browser and self-hosted runtime owners do not match",
            ));
        }
    }
    let idle_ttl_seconds = coerce_idle_ttl(payload.idle_ttl_seconds);
    let display_name = normalize_display_name_owned(payload.display_name);
    let lease_id_from_token = scoped_claims
        .as_ref()
        .and_then(|claims| claims.lease_id.as_deref())
        .map(|value| {
            Uuid::from_str(value).map_err(|_| unauthorized("runtime token lease scope is invalid"))
        })
        .transpose()?;
    ensure_runtime_token_lease_matches_request(
        scoped_claims.is_some(),
        lease_id_from_token,
        lease_id,
    )?;
    let workspace_manifest = payload.workspace_manifest.clone();
    let lease_scope_override = payload.lease_scope.clone();

    let mut conn = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = conn
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = match load_project_record(&transaction, &project_id).await {
        Ok(project) => project,
        Err((status, _))
            if status == StatusCode::NOT_FOUND && state.config.auto_create_projects =>
        {
            ensure_project_exists(&transaction, &project_id, state.config.auto_create_projects)
                .await?;
            load_project_record(&transaction, &project_id).await?
        }
        Err(err) => return Err(err),
    };
    authorize_provider_for_project(&state, &runtime_provider, project.org_id)?;

    let registration_identity = lock_runtime_registration_identity(
        &state,
        &transaction,
        &project_id,
        lease_id,
        runtime_id_from_token,
        self_hosted_owner,
    )
    .await?;
    let lease_details = registration_identity.lease_details;
    let runtime_id_override = registration_identity.runtime_id;

    // A scoped runtime token's signed lease/runtime binding was validated
    // against the request earlier. Revalidate it against the lease row that was
    // actually locked so a rejected token cannot use a different lease as a
    // runtime-selection oracle.
    if let Some(binding) = scoped_binding {
        if let Some(lease) = lease_details.as_ref() {
            validate_loaded_lease_binding(binding, lease.id, lease.runtime_id)?;
        }
    }

    let runtime = ensure_runtime_record(
        &transaction,
        &project_id,
        runtime_id_override,
        &runtime_provider,
        idle_ttl_seconds,
        display_name.as_deref(),
        payload.metadata.clone(),
        true,
    )
    .await?;
    // The payload provider is client-controlled. Revalidate against the
    // locked/loaded runtime record as well, so a member token cannot label an
    // existing hosted runtime as self-hosted and upgrade itself to an agent
    // token for that allocation.
    ensure_provider_managed_registration_is_controller_attested(
        super::access::runtime_is_private_self_hosted(
            &state,
            &runtime.provider,
            &runtime.capabilities,
        ),
        scoped_claims.as_ref(),
        state.config.service_runtime_user_id,
    )?;

    let runtime_generation = if super::access::runtime_is_private_self_hosted(
        &state,
        &runtime.provider,
        &runtime.capabilities,
    ) {
        if let Some(claims) = scoped_claims.as_ref() {
            Some(
                ensure_runtime_generation_matches(&runtime.capabilities, claims)?
                    .unwrap_or(effective_runtime_generation(claims)?),
            )
        } else {
            Some(Uuid::new_v4())
        }
    } else {
        None
    };

    if let Some(expected) = runtime.active_lease_id {
        let provided = lease_details.as_ref().map(|lease| lease.id).or(lease_id);
        let Some(provided_id) = provided else {
            return Err(crate::bad_request(
                "leaseId is required to register this runtime",
            ));
        };
        if provided_id != expected {
            return Err(crate::bad_request(
                "leaseId does not match the active runtime lease",
            ));
        }
    }

    if let Some(lease) = lease_details.as_ref() {
        if lease.project_id != project_id {
            return Err(forbidden("runtime lease does not belong to project"));
        }
        let lease_runtime_id = lease.runtime_id.or(runtime_id_from_token);
        if lease.runtime_id.is_none() {
            if let Some(runtime_id) = lease_runtime_id {
                transaction
                    .execute(
                        "update runtime_leases set runtime_id = $2, updated_at = now() where id = $1",
                        &[&lease.id, &runtime_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!(
                            "failed to associate runtime lease with runtime: {error}"
                        ))
                    })?;
            }
        }
        let Some(lease_runtime_id) = lease_runtime_id else {
            return Err(crate::bad_request(
                "runtime lease is not associated with a runtime",
            ));
        };
        if lease_runtime_id != runtime.id {
            return Err(crate::bad_request(
                "runtime lease does not match requested runtime",
            ));
        }
        ensure_runtime_lease_is_registerable(lease)?;
        if let Some(scope_raw) = lease_scope_override.as_deref() {
            let expected_scope = parse_lease_scope(Some(scope_raw))?;
            if lease.scope != expected_scope {
                return Err(crate::bad_request(
                    "leaseScope does not match active runtime lease",
                ));
            }
        }
        if let Some(manifest) = workspace_manifest.clone() {
            let mut meta_map = serde_json::Map::new();
            meta_map.insert("workspaceManifest".to_string(), manifest.clone());
            let metadata_value = JsonValue::Object(meta_map);
            transaction
                .execute(
                    "update runtime_leases set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1",
                    &[&lease.id, &metadata_value],
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to update runtime lease workspace metadata: {error}"
                    ))
                })?;
        }
        mark_runtime_lease_active(&transaction, &lease.id).await?;
    }

    let shared_browser_agent_consent = lease_details.as_ref().is_some_and(|lease| {
        runtime.active_lease_id == Some(lease.id)
            && super::managed::managed_webdev_launch_is_attested(
                &runtime.provider,
                lease.metadata.as_ref(),
                lease.id,
            )
    });
    let mut capabilities = attest_runtime_capabilities(
        payload.capabilities,
        personal_browser_owner,
        self_hosted_owner,
        shared_browser_agent_consent,
    );
    if let Some(generation) = runtime_generation {
        set_runtime_generation_capability(&mut capabilities, generation);
    }

    let endpoint_url = payload.endpoint_url.clone();
    let task_ref = payload.task_ref.clone();

    let updated = transaction
        .query_one(
            r#"
            update runtimes
            set status = 'ready',
                endpoint_url = $1,
                task_ref = $2,
                capabilities = coalesce($3::jsonb, '{}'::jsonb),
                idle_ttl_seconds = $4,
                display_name = coalesce($5, display_name),
                last_seen_at = now(),
                updated_at = now()
            where id = $6
            returning id, project_id, provider, status, endpoint_url, task_ref, capabilities, idle_ttl_seconds, display_name, active_lease_id
            "#,
            &[
                &endpoint_url,
                &task_ref,
                &capabilities,
                &(idle_ttl_seconds as i32),
                &display_name,
                &runtime.id,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update runtime: {error}")))?;

    let updated_runtime = map_runtime_row(&updated)?;

    let mut registration_details = json!({
        "version": payload.version,
        "endpoint_url": endpoint_url,
        "task_ref": task_ref,
        "metadata": payload.metadata,
        "display_name": display_name
    });
    if let Some(lease) = lease_details.as_ref() {
        if let Some(map) = registration_details.as_object_mut() {
            map.insert(
                "lease_id".to_string(),
                JsonValue::String(lease.id.to_string()),
            );
            map.insert(
                "lease_scope".to_string(),
                JsonValue::String(lease.scope.as_str().to_string()),
            );
            if let Some(manifest) = workspace_manifest.clone() {
                map.insert("workspace_manifest".to_string(), manifest);
            }
            if let Some(scope_override) = lease_scope_override.clone() {
                map.insert(
                    "requested_lease_scope".to_string(),
                    JsonValue::String(scope_override),
                );
            }
        }
    }

    record_runtime_event(
        &transaction,
        &updated_runtime.id,
        &project_id,
        "registered",
        registration_details,
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit runtime/register: {error}")))?;

    let agent_token = issue_agent_token_for_runtime(
        &state.config,
        &project_id,
        &updated_runtime.id,
        updated_runtime.active_lease_id.as_ref(),
        runtime_generation,
        &updated_runtime.provider,
        &updated_runtime.capabilities,
    )?;
    let agent_token_issued_at =
        DateTime::<Utc>::from_timestamp(agent_token.issued_at, 0).map(|dt| dt.to_rfc3339());
    let agent_token_expires_at =
        DateTime::<Utc>::from_timestamp(agent_token.expires_at, 0).map(|dt| dt.to_rfc3339());

    let proxy_envelope = issue_proxy_envelope(
        &state.config,
        &project_id,
        &updated_runtime.id,
        None,
        None,
        None,
        None,
        None,
    );

    let runtime_token = mint_scoped_token_with_runtime_generation(
        &state.config,
        ScopedTokenRequest {
            audience: updated_runtime.id.to_string(),
            // Preserve the immutable authenticated owner on every renewed
            // self-hosted token. Otherwise an ordinary desktop runtime would
            // silently become service-owned after its first registration.
            subject: renewed_runtime_token_subject(
                self_hosted_owner,
                state.config.service_runtime_user_id,
            ),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(updated_runtime.id.to_string()),
            protocol: None,
            scopes: default_runtime_token_scopes()
                .into_iter()
                .chain(personal_browser_owner.map(|_| PERSONAL_BROWSER_RUNTIME_SCOPE.to_string()))
                .collect(),
            lease_id: lease_details.as_ref().map(|lease| lease.id.to_string()),
            run_id: None,
            prefer_runtime: None,
            // The runtime-agent keeps this token for its next agent-token
            // renewal. It must outlive the agent token instead of inheriting
            // the short origin-only default (typically five minutes).
            ttl_seconds: Some(
                state
                    .config
                    .agent_token_ttl_seconds
                    .max(RENEWED_RUNTIME_TOKEN_MIN_TTL_SECONDS),
            ),
        },
        runtime_generation,
    )
    .ok();

    let response = RuntimeRegisterResponse {
        runtime_id: updated_runtime.id,
        agent_token: agent_token.token,
        agent_token_issued_at,
        agent_token_expires_at,
        agent_token_scopes: Some(agent_token.scopes.clone()),
        agent_token_ttl: Some(agent_token.expires_in),
        lease_url: state.config.lease_path.clone(),
        heartbeat_url: state.config.heartbeat_path.clone(),
        stop_url: Some(state.config.stop_path.clone()),
        lease_id: lease_details.as_ref().map(|lease| lease.id),
        proxy: proxy_envelope,
        runtime_token: runtime_token.as_ref().map(|t| t.token.clone()),
    };

    Ok(Json(response))
}

#[cfg(test)]
mod concurrency_tests {
    use std::time::Duration;

    use tokio::time::{sleep, timeout};

    use super::*;

    async fn run_registration_lifecycle_race(
        final_lease_status: &str,
    ) -> anyhow::Result<(String, Option<(StatusCode, String)>)> {
        let pool = crate::tests::require_origin_test_pool("registration lifecycle race").await?;

        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into projects (id, project_type, status)
                     values ($1, 'customer', 'active')",
                    &[&project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtimes
                        (id, project_id, provider, status, idle_ttl_seconds)
                     values ($1, $2, 'default', 'requested', 600)",
                    &[&runtime_id, &project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtime_leases
                        (id, project_id, runtime_id, status, requested_at)
                     values ($1, $2, $3, 'launching', now())",
                    &[&lease_id, &project_id, &runtime_id],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set active_lease_id = $2 where id = $1",
                    &[&runtime_id, &lease_id],
                )
                .await?;
        }

        // Model the lifecycle transaction used by stop/sweep code: it owns the
        // runtime row first and will need the active lease next.
        let mut lifecycle_connection = pool.get().await?;
        let lifecycle_transaction = lifecycle_connection.transaction().await?;
        lifecycle_transaction
            .query_one(
                "select id from runtimes where id = $1 for update",
                &[&runtime_id],
            )
            .await?;

        let application_name = format!("register-lock-order-{lease_id}");
        let registration_pool = pool.clone();
        let registration_state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "register-lock-order",
            ),
        );
        let registration_application_name = application_name.clone();
        let registration_task = tokio::spawn(async move {
            let mut connection = registration_pool.get().await?;
            let transaction = connection.transaction().await?;
            transaction
                .query_one(
                    "select set_config('application_name', $1, true)",
                    &[&registration_application_name],
                )
                .await?;

            let identity = lock_runtime_registration_identity(
                &registration_state,
                &transaction,
                &project_id,
                Some(lease_id),
                None,
                None,
            )
            .await
            .map_err(|(status, body)| {
                anyhow::anyhow!(
                    "registration identity failed ({status}): {}",
                    body.0.message
                )
            })?;
            let lease = identity
                .lease_details
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("registration lost its requested lease"))?;
            let rejection = ensure_runtime_lease_is_registerable(lease)
                .err()
                .map(|(status, body)| (status, body.0.message));
            let observed_status = lease.status.clone();
            transaction.rollback().await?;
            Ok::<_, anyhow::Error>((observed_status, rejection))
        });

        // Do not use a timing-only assertion. Wait until PostgreSQL confirms
        // that the registration connection is blocked on the runtime lock.
        let observer = pool.get().await?;
        timeout(Duration::from_secs(3), async {
            loop {
                let row = observer
                    .query_opt(
                        "select wait_event_type
                         from pg_stat_activity
                         where application_name = $1
                           and pid <> pg_backend_pid()",
                        &[&application_name],
                    )
                    .await?;
                if row
                    .as_ref()
                    .and_then(|row| row.get::<_, Option<&str>>("wait_event_type"))
                    == Some("Lock")
                {
                    return Ok::<_, anyhow::Error>(());
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("registration never waited on the runtime row"))??;

        // If registration had locked the lease before waiting on the runtime,
        // this acquisition would time out and reproduce the old deadlock.
        timeout(
            Duration::from_secs(1),
            lifecycle_transaction.query_one(
                "select id from runtime_leases where id = $1 for update",
                &[&lease_id],
            ),
        )
        .await
        .map_err(|_| anyhow::anyhow!("registration locked lease before runtime"))??;

        let runtime_status = if final_lease_status == "released" {
            "stopped"
        } else {
            "requested"
        };
        lifecycle_transaction
            .execute(
                "update runtime_leases
                 set status = $2,
                     released_at = case when $2 = 'released' then now() else null end,
                     updated_at = now()
                 where id = $1",
                &[&lease_id, &final_lease_status],
            )
            .await?;
        lifecycle_transaction
            .execute(
                "update runtimes set status = $2, updated_at = now() where id = $1",
                &[&runtime_id, &runtime_status],
            )
            .await?;
        lifecycle_transaction.commit().await?;

        let registration_result = timeout(Duration::from_secs(3), registration_task)
            .await
            .map_err(|_| anyhow::anyhow!("registration did not resume after lifecycle commit"))??;
        let result = registration_result?;

        let connection = pool.get().await?;
        connection
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;

        Ok(result)
    }

    #[tokio::test]
    async fn registration_and_stop_share_runtime_then_lease_lock_order() -> anyhow::Result<()> {
        let (observed_status, rejection) = run_registration_lifecycle_race("released").await?;
        assert_eq!(observed_status, "released");
        let (status, message) = rejection.expect("released lease must reject registration");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(message, "runtime lease has already been released");
        Ok(())
    }

    #[tokio::test]
    async fn registration_observes_concurrent_cleanup_pending_quarantine() -> anyhow::Result<()> {
        let (observed_status, rejection) =
            run_registration_lifecycle_race("cleanup_pending").await?;
        assert_eq!(observed_status, "cleanup_pending");
        let (status, message) = rejection.expect("quarantined lease must reject registration");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            message,
            "runtime lease in state cleanup_pending cannot be registered"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_claims(scopes: &[&str]) -> AccessTokenClaims {
        AccessTokenClaims {
            aud: Uuid::new_v4().to_string(),
            sub: Uuid::new_v4().to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: None,
            runtime_id: Some(Uuid::new_v4().to_string()),
            protocol: None,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            lease_id: Some(Uuid::new_v4().to_string()),
            runtime_generation: None,
            run_id: None,
            iat: Utc::now().timestamp(),
            exp: Utc::now().timestamp() + 300,
            jti: Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        }
    }

    #[test]
    fn pre_git_delegation_runtime_tokens_remain_valid_during_rolling_deploys() {
        let legacy = runtime_claims(RUNTIME_TOKEN_REQUIRED_SCOPES);
        assert!(runtime_token_has_required_scopes(&legacy));

        let expanded = runtime_claims(RUNTIME_TOKEN_DEFAULT_SCOPES);
        assert!(runtime_token_has_required_scopes(&expanded));

        let mut incomplete = legacy;
        incomplete.scopes.retain(|scope| scope != "agent.lease");
        assert!(!runtime_token_has_required_scopes(&incomplete));
    }

    fn bound_runtime_claims(
        project_id: Uuid,
        runtime_id: Uuid,
        lease_id: Uuid,
    ) -> AccessTokenClaims {
        let mut claims = runtime_claims(RUNTIME_TOKEN_DEFAULT_SCOPES);
        claims.aud = runtime_id.to_string();
        claims.project_id = project_id.to_string();
        claims.runtime_id = Some(runtime_id.to_string());
        claims.lease_id = Some(lease_id.to_string());
        claims
    }

    #[test]
    fn scoped_runtime_registration_accepts_matching_signed_bindings() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let claims = bound_runtime_claims(project_id, runtime_id, lease_id);

        let binding = validate_scoped_runtime_registration_binding(
            &claims,
            project_id,
            Some(runtime_id),
            Some(lease_id),
        )
        .expect("matching runtime registration binding");
        assert_eq!(binding.runtime_id, Some(runtime_id));
        assert_eq!(binding.lease_id, Some(lease_id));
        validate_loaded_lease_binding(binding, lease_id, Some(runtime_id))
            .expect("matching loaded lease binding");

        // Older agents omitted runtimeId from the registration body, while
        // older controllers minted project-audience renewed tokens. The
        // signed runtime and lease remain authoritative in that safe rollout
        // combination.
        let mut legacy_claims = claims;
        legacy_claims.aud = project_id.to_string();
        validate_scoped_runtime_registration_binding(
            &legacy_claims,
            project_id,
            None,
            Some(lease_id),
        )
        .expect("safe legacy registration binding");
    }

    #[test]
    fn scoped_runtime_registration_rejects_cross_runtime_binding() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let other_runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let claims = bound_runtime_claims(project_id, runtime_id, lease_id);

        assert!(validate_scoped_runtime_registration_binding(
            &claims,
            project_id,
            Some(other_runtime_id),
            Some(lease_id),
        )
        .is_err());

        let binding = validate_scoped_runtime_registration_binding(
            &claims,
            project_id,
            Some(runtime_id),
            Some(lease_id),
        )
        .expect("valid signed binding");
        assert!(validate_loaded_lease_binding(binding, lease_id, Some(other_runtime_id)).is_err());

        let mut wrong_audience = claims;
        wrong_audience.aud = other_runtime_id.to_string();
        assert!(validate_scoped_runtime_registration_binding(
            &wrong_audience,
            project_id,
            Some(runtime_id),
            Some(lease_id),
        )
        .is_err());
    }

    #[test]
    fn scoped_runtime_registration_rejects_cross_lease_binding() {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let other_lease_id = Uuid::new_v4();
        let claims = bound_runtime_claims(project_id, runtime_id, lease_id);

        assert!(validate_scoped_runtime_registration_binding(
            &claims,
            project_id,
            Some(runtime_id),
            Some(other_lease_id),
        )
        .is_err());
        assert!(validate_scoped_runtime_registration_binding(
            &claims,
            project_id,
            Some(runtime_id),
            None,
        )
        .is_err());
        let binding = validate_scoped_runtime_registration_binding(
            &claims,
            project_id,
            Some(runtime_id),
            Some(lease_id),
        )
        .expect("valid signed binding");
        assert!(validate_loaded_lease_binding(binding, other_lease_id, Some(runtime_id)).is_err());

        let mut unbound_claims = claims;
        unbound_claims.aud = project_id.to_string();
        unbound_claims.runtime_id = None;
        unbound_claims.lease_id = None;
        assert!(validate_scoped_runtime_registration_binding(
            &unbound_claims,
            project_id,
            None,
            Some(lease_id),
        )
        .is_err());
    }

    #[test]
    fn personal_browser_capability_is_controller_attested() {
        let spoofed = attest_runtime_capabilities(
            Some(json!({
                "agent": true,
                "personalBrowser": {
                    "enabled": true,
                    "ownerUserId": Uuid::new_v4().to_string(),
                },
                (RUNTIME_TOKEN_GENERATION_CAPABILITY): Uuid::new_v4().to_string(),
            })),
            None,
            None,
            false,
        );
        assert_eq!(spoofed["agent"], json!(true));
        assert!(spoofed.get("personalBrowser").is_none());
        assert!(spoofed.get(RUNTIME_TOKEN_GENERATION_CAPABILITY).is_none());

        let owner_user_id = Uuid::new_v4();
        let attested = attest_runtime_capabilities(
            Some(json!({ "agent": true })),
            Some(owner_user_id),
            Some(owner_user_id),
            false,
        );
        assert_eq!(attested["personalBrowser"]["enabled"], json!(true));
        assert_eq!(
            attested["personalBrowser"]["ownerUserId"],
            json!(owner_user_id.to_string())
        );
        assert_eq!(
            attested[crate::runtime::access::SELF_HOSTED_ACCESS_CAPABILITY]["ownerUserId"],
            json!(owner_user_id.to_string())
        );
    }

    #[test]
    fn shared_browser_agent_consent_capability_is_controller_attested() {
        let protected = crate::runtime::managed::SHARED_BROWSER_AGENT_CONSENT_CAPABILITY;
        let spoofed = attest_runtime_capabilities(
            Some(json!({
                "agent": true,
                (protected): { "version": 999 },
            })),
            None,
            None,
            false,
        );
        assert_eq!(spoofed["agent"], true);
        assert!(spoofed.get(protected).is_none());

        let attested = attest_runtime_capabilities(
            Some(json!({
                "agent": true,
                (protected): { "version": 999 },
            })),
            None,
            None,
            true,
        );
        assert_eq!(attested[protected], json!({ "version": 1 }));
    }

    #[test]
    fn personal_browser_owner_survives_runtime_token_renewal() {
        let owner_user_id = Uuid::new_v4();
        let service_runtime_user_id = Uuid::new_v4();

        assert_eq!(
            renewed_runtime_token_subject(Some(owner_user_id), Some(service_runtime_user_id)),
            owner_user_id.to_string()
        );
        assert_eq!(
            renewed_runtime_token_subject(None, Some(service_runtime_user_id)),
            service_runtime_user_id.to_string()
        );
        assert_eq!(renewed_runtime_token_subject(None, None), "runtime.service");
    }

    #[test]
    fn hosted_runtime_registration_requires_controller_service_subject() {
        let service_runtime_user_id = Uuid::new_v4();
        let member_user_id = Uuid::new_v4();

        assert!(runtime_token_subject_is_controller_service(
            &service_runtime_user_id.to_string(),
            Some(service_runtime_user_id)
        ));
        assert!(runtime_token_subject_is_controller_service(
            "runtime.service",
            Some(service_runtime_user_id)
        ));
        assert!(!runtime_token_subject_is_controller_service(
            &member_user_id.to_string(),
            Some(service_runtime_user_id)
        ));
    }

    #[test]
    fn existing_self_hosted_owner_cannot_be_replaced_or_cleared() {
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let capabilities = json!({
            "agent": true,
            "personalBrowser": {
                "enabled": true,
                "ownerUserId": owner.to_string(),
            }
        });

        assert!(existing_self_hosted_owner_is_authorized(
            &capabilities,
            Some(owner)
        ));
        assert!(!existing_self_hosted_owner_is_authorized(
            &capabilities,
            Some(other)
        ));
        assert!(!existing_self_hosted_owner_is_authorized(
            &capabilities,
            None
        ));
        assert!(!existing_self_hosted_owner_is_authorized(
            &json!({ "agent": true }),
            Some(other)
        ));
        assert!(!existing_self_hosted_owner_is_authorized(
            &json!({ "agent": true }),
            None
        ));
    }

    #[test]
    fn lease_identity_cannot_override_runtime_token_identity() {
        let lease_runtime_id = Uuid::new_v4();
        let token_runtime_id = Uuid::new_v4();

        let (status, body) =
            resolve_registration_runtime_id(Some(lease_runtime_id), Some(token_runtime_id))
                .expect_err("a runtime-scoped token must not register another runtime's lease");
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            body.0.message,
            "runtime token does not match the requested runtime lease"
        );
        assert_eq!(
            resolve_registration_runtime_id(Some(lease_runtime_id), Some(lease_runtime_id))
                .expect("matching identities should resolve"),
            Some(lease_runtime_id)
        );
    }

    #[test]
    fn scoped_runtime_token_is_bound_to_requested_lease_generation() {
        let lease_id = Uuid::new_v4();
        let stale_lease_id = Uuid::new_v4();

        ensure_runtime_token_lease_matches_request(true, Some(lease_id), Some(lease_id))
            .expect("matching lease generation should register");

        for (token_lease_id, requested_lease_id) in [
            (Some(stale_lease_id), Some(lease_id)),
            (Some(lease_id), None),
            (None, Some(lease_id)),
        ] {
            let (status, body) = ensure_runtime_token_lease_matches_request(
                true,
                token_lease_id,
                requested_lease_id,
            )
            .expect_err("scoped token and request must name the same lease");
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(
                body.0.message,
                "runtime token lease scope does not match requested runtime lease"
            );
        }

        ensure_runtime_token_lease_matches_request(false, None, Some(lease_id))
            .expect("service-role registration is authorized outside scoped token claims");
    }
}
