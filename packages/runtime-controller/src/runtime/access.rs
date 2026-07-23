use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{forbidden, ApiError, AppState};

pub(crate) const SELF_HOSTED_ACCESS_CAPABILITY: &str = "_instafySelfHostedAccess";

const LEGACY_SELF_HOSTED_ACCESS_CAPABILITY: &str = "_instafy_self_hosted_access";

fn owner_from_capability(capability: &JsonValue) -> Option<Uuid> {
    if capability
        .get("mode")
        .and_then(JsonValue::as_str)
        .is_some_and(|mode| mode != "private")
    {
        return None;
    }

    capability
        .get("ownerUserId")
        .or_else(|| capability.get("owner_user_id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

fn personal_browser_owner_from_capabilities(capabilities: &JsonValue) -> Option<Uuid> {
    let capability = capabilities
        .get("personalBrowser")
        .or_else(|| capabilities.get("personal_browser"))?;
    if capability.get("enabled").and_then(JsonValue::as_bool) != Some(true) {
        return None;
    }
    capability
        .get("ownerUserId")
        .or_else(|| capability.get("owner_user_id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

/// Return the immutable human owner attested by the controller at registration.
///
/// Personal Browser predates the general self-hosted access capability. Its
/// controller-owned owner field is accepted as a safe compatibility source,
/// but new registrations always persist both attestations.
pub(crate) fn self_hosted_owner_user_id(capabilities: &JsonValue) -> Option<Uuid> {
    capabilities
        .get(SELF_HOSTED_ACCESS_CAPABILITY)
        .or_else(|| capabilities.get(LEGACY_SELF_HOSTED_ACCESS_CAPABILITY))
        .and_then(owner_from_capability)
        .or_else(|| personal_browser_owner_from_capabilities(capabilities))
}

/// Detect only the built-in id or a protected runtime attestation.
///
/// This is useful for validating already-classified provider snapshots. Access
/// control must use [`runtime_is_private_self_hosted`] so custom provider kinds
/// cannot fail open when capabilities are absent.
pub(crate) fn runtime_has_private_self_hosted_identity(
    provider: &str,
    capabilities: &JsonValue,
) -> bool {
    crate::provider_identifiers::is_self_hosted_provider_id(provider)
        || capabilities.get(SELF_HOSTED_ACCESS_CAPABILITY).is_some()
        || capabilities
            .get(LEGACY_SELF_HOSTED_ACCESS_CAPABILITY)
            .is_some()
        || capabilities.get("personalBrowser").is_some()
        || capabilities.get("personal_browser").is_some()
}

/// Classify every self-hosted runtime as private, including custom provider
/// ids whose self-hosted identity lives only in the controller-owned provider
/// registry. Runtime capability JSON is runtime-supplied input and therefore
/// cannot be the sole source of truth for this access boundary.
pub(crate) fn runtime_is_private_self_hosted(
    state: &AppState,
    provider: &str,
    capabilities: &JsonValue,
) -> bool {
    let configured_provider = state.provider_registry.provider_config(provider);
    runtime_is_private_or_quarantined_for_provider_snapshot(
        provider,
        capabilities,
        configured_provider
            .as_ref()
            .map(|provider| provider.kind.as_str()),
    )
}

pub(crate) fn provider_is_private_self_hosted_or_quarantined(
    state: &AppState,
    provider: &str,
) -> bool {
    let configured_provider = state.provider_registry.provider_config(provider);
    runtime_is_private_or_quarantined_for_provider_snapshot(
        provider,
        &JsonValue::Null,
        configured_provider
            .as_ref()
            .map(|provider| provider.kind.as_str()),
    )
}

fn runtime_is_private_or_quarantined_for_provider_snapshot(
    provider: &str,
    capabilities: &JsonValue,
    configured_provider_kind: Option<&str>,
) -> bool {
    if runtime_has_private_self_hosted_identity(provider, capabilities) {
        return true;
    }
    if crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(provider) {
        return false;
    }
    match configured_provider_kind {
        Some(kind) => crate::provider_identifiers::is_self_hosted_provider_kind(kind),
        // Provider removal must not reclassify stale private machines as
        // managed/shareable. Service-role cleanup remains available through
        // the caller's explicit bypass, while all human access fails closed.
        None => true,
    }
}

pub(crate) fn remove_self_hosted_access_attestation(
    capabilities: &mut serde_json::Map<String, JsonValue>,
) {
    capabilities.remove(SELF_HOSTED_ACCESS_CAPABILITY);
    capabilities.remove(LEGACY_SELF_HOSTED_ACCESS_CAPABILITY);
}

pub(crate) fn set_self_hosted_access_attestation(
    capabilities: &mut serde_json::Map<String, JsonValue>,
    owner_user_id: Uuid,
) {
    remove_self_hosted_access_attestation(capabilities);
    capabilities.insert(
        SELF_HOSTED_ACCESS_CAPABILITY.to_string(),
        json!({
            "mode": "private",
            "ownerUserId": owner_user_id.to_string(),
        }),
    );
}

pub(crate) fn self_hosted_runtime_is_accessible_to_user(
    state: &AppState,
    provider: &str,
    capabilities: &JsonValue,
    user_id: Option<Uuid>,
    is_service_role: bool,
) -> bool {
    if !runtime_is_private_self_hosted(state, provider, capabilities) || is_service_role {
        return true;
    }
    user_id.is_some_and(|user_id| self_hosted_owner_user_id(capabilities) == Some(user_id))
}

pub(crate) fn ensure_self_hosted_runtime_access(
    state: &AppState,
    provider: &str,
    capabilities: &JsonValue,
    user_id: Option<Uuid>,
    is_service_role: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if self_hosted_runtime_is_accessible_to_user(
        state,
        provider,
        capabilities,
        user_id,
        is_service_role,
    ) {
        return Ok(());
    }
    Err(forbidden(
        "Self-hosted runtime is private to its authenticated owner",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_attestation_is_private_and_replaces_spoofed_values() {
        let owner = Uuid::new_v4();
        let attacker = Uuid::new_v4();
        let mut capabilities = serde_json::Map::from_iter([(
            SELF_HOSTED_ACCESS_CAPABILITY.to_string(),
            json!({ "mode": "team", "ownerUserId": attacker.to_string() }),
        )]);

        set_self_hosted_access_attestation(&mut capabilities, owner);
        let capabilities = JsonValue::Object(capabilities);
        assert_eq!(self_hosted_owner_user_id(&capabilities), Some(owner));
        assert!(runtime_has_private_self_hosted_identity(
            "self-hosted",
            &capabilities,
        ));
        assert_eq!(self_hosted_owner_user_id(&capabilities), Some(owner));
        assert_ne!(self_hosted_owner_user_id(&capabilities), Some(attacker));
    }

    #[test]
    fn builtin_self_hosted_identity_is_detected_without_attestation() {
        assert!(runtime_has_private_self_hosted_identity(
            "self_hosted",
            &json!({ "agent": true }),
        ));
        assert!(!runtime_has_private_self_hosted_identity(
            "instafy-cloud",
            &json!({}),
        ));
    }

    #[test]
    fn unknown_provider_rows_are_quarantined_but_exact_cloud_remains_managed() {
        let capabilities = json!({});
        assert!(runtime_is_private_or_quarantined_for_provider_snapshot(
            "removed-custom-provider",
            &capabilities,
            None,
        ));
        assert!(!runtime_is_private_or_quarantined_for_provider_snapshot(
            "removed-custom-provider",
            &capabilities,
            Some("external_http"),
        ));
        assert!(runtime_is_private_or_quarantined_for_provider_snapshot(
            "custom-local-provider",
            &capabilities,
            Some("self_hosted"),
        ));
        assert!(!runtime_is_private_or_quarantined_for_provider_snapshot(
            "instafy-cloud",
            &capabilities,
            None,
        ));
        assert!(runtime_is_private_or_quarantined_for_provider_snapshot(
            "instafy-cloud-custom",
            &capabilities,
            None,
        ));
    }

    #[test]
    fn personal_browser_owner_remains_a_safe_compatibility_attestation() {
        let owner = Uuid::new_v4();
        let capabilities = json!({
            "personalBrowser": {
                "enabled": true,
                "ownerUserId": owner.to_string(),
            }
        });
        assert_eq!(self_hosted_owner_user_id(&capabilities), Some(owner));
    }
}
