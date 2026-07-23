use serde_json::{json, Map as JsonMap, Value as JsonValue};
use uuid::Uuid;

pub(crate) const MANAGED_RUNTIME_FLAVOR_KEY: &str = "runtimeFlavor";
pub(crate) const MANAGED_RUNTIME_WEBDEV_FLAVOR: &str = "webdev";
pub(crate) const MANAGED_RUNTIME_LAUNCH_ATTESTATION: &str = "_instafyManagedRuntimeLaunch";
pub(crate) const SHARED_BROWSER_AGENT_CONSENT_CAPABILITY: &str =
    "_instafySharedBrowserAgentConsent";

const MANAGED_RUNTIME_LAUNCH_ATTESTATION_VERSION: u64 = 1;
pub(crate) const SHARED_BROWSER_AGENT_CONSENT_VERSION: u64 = 1;

pub(crate) fn runtime_supports_shared_browser_agent_consent(capabilities: &JsonValue) -> bool {
    capabilities
        .get(SHARED_BROWSER_AGENT_CONSENT_CAPABILITY)
        .and_then(JsonValue::as_object)
        .and_then(|capability| capability.get("version"))
        .and_then(JsonValue::as_u64)
        == Some(SHARED_BROWSER_AGENT_CONSENT_VERSION)
}

/// Client-selected metadata that is meaningful to an Instafy-managed runtime.
///
/// Keep this list deliberately small. Exact-managed request metadata is later
/// merged with controller/provider policy and reaches a privileged allocator;
/// accepting arbitrary top-level fields would make newly-added allocator
/// controls caller-selectable by accident.
fn allowed_managed_runtime_request_metadata_key(key: &str) -> bool {
    matches!(
        key,
        MANAGED_RUNTIME_FLAVOR_KEY | "source" | "runtimeImagePreset" | "sizeId" | "env"
    )
}

/// Runtime-container settings that a browser/client may select for an exact
/// managed allocation. These names are not interpreted by Docker, Compose,
/// BuildKit, the provider shell, or the provider executable itself.
///
/// Controller-derived resource limits, git remotes, profile persistence and
/// TURN credentials are intentionally absent: their authoritative values are
/// injected only after this request boundary.
fn allowed_managed_runtime_request_env_key(key: &str) -> bool {
    matches!(
        key,
        // Shared Browser launch and rendering preferences.
        "INSTAFY_ENABLE_BROWSER_SESSION"
            | "INSTAFY_BROWSER_VIEWPORT_ONLY"
            | "INSTAFY_BROWSER_RENDER_SCALE"
            | "INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS"
            | "INSTAFY_BROWSER_CDP_SCREENCAST"
            | "INSTAFY_BROWSER_WEBRTC_ENABLED"
            | "INSTAFY_BROWSER_PREFERRED_VIEWER"
            | "INSTAFY_BROWSER_DISPLAY"
            | "INSTAFY_VNC_PORT"
            | "INSTAFY_VNC_GEOMETRY"
    )
}

fn canonical_managed_runtime_env_value(value: &JsonValue) -> Option<JsonValue> {
    let rendered = match value {
        JsonValue::String(value) => value.clone(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::Bool(value) => {
            if *value {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        JsonValue::Null | JsonValue::Array(_) | JsonValue::Object(_) => return None,
    };
    Some(JsonValue::String(rendered))
}

fn exact_managed_provider(provider: &str) -> bool {
    crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(provider)
}

fn metadata_object(metadata: Option<JsonValue>) -> JsonMap<String, JsonValue> {
    match metadata {
        Some(JsonValue::Object(map)) => map,
        Some(other) => {
            let mut map = JsonMap::new();
            map.insert("runtimeMetadata".to_string(), other);
            map
        }
        None => JsonMap::new(),
    }
}

/// Give every managed runtime policy one representation to evaluate before the
/// metadata reaches the allocator. Docker and cloud-init ultimately render
/// scalar JSON values as strings, so leaving booleans/numbers in the controller
/// would let (for example) `true` bypass an exact `"1"` policy check and become
/// `1` only after the trust boundary.
pub(crate) fn canonicalize_managed_runtime_env_values(
    provider: &str,
    metadata: Option<JsonValue>,
) -> Option<JsonValue> {
    if !exact_managed_provider(provider) {
        return metadata;
    }

    let mut root = metadata_object(metadata);
    if let Some(env) = root.get_mut("env").and_then(JsonValue::as_object_mut) {
        env.retain(|_, value| {
            let Some(canonical) = canonical_managed_runtime_env_value(value) else {
                return false;
            };
            *value = canonical;
            true
        });
    } else {
        root.remove("env");
    }
    Some(JsonValue::Object(root))
}

fn normalized_requested_flavor(
    metadata: &JsonMap<String, JsonValue>,
) -> Result<Option<&'static str>, &'static str> {
    let Some(value) = metadata.get(MANAGED_RUNTIME_FLAVOR_KEY) else {
        return Ok(None);
    };
    match value.as_str() {
        Some(MANAGED_RUNTIME_WEBDEV_FLAVOR) => Ok(Some(MANAGED_RUNTIME_WEBDEV_FLAVOR)),
        _ => Err("managed runtimeFlavor must be exactly 'webdev' when supplied"),
    }
}

/// Remove launch authority that a project member must never choose directly.
///
/// The public `runtimeFlavor` field is intentionally harmless: for the exact
/// managed provider it selects a controller/provider-owned image mapping. It
/// is not an image reference and cannot become an attestation until a new
/// controller-created lease generation is persisted below.
pub(crate) fn sanitize_managed_runtime_request_metadata(
    provider: &str,
    metadata: Option<JsonValue>,
) -> Result<Option<JsonValue>, &'static str> {
    if !exact_managed_provider(provider) {
        return Ok(metadata);
    }

    let mut root = metadata_object(metadata);
    normalized_requested_flavor(&root)?;

    root.retain(|key, _| allowed_managed_runtime_request_metadata_key(key));
    if let Some(env) = root.get_mut("env").and_then(JsonValue::as_object_mut) {
        env.retain(|key, _| allowed_managed_runtime_request_env_key(key));
    } else {
        root.remove("env");
    }

    Ok(canonicalize_managed_runtime_env_values(
        provider,
        Some(JsonValue::Object(root)),
    ))
}

fn launch_attestation(lease_id: Uuid) -> JsonValue {
    json!({
        "version": MANAGED_RUNTIME_LAUNCH_ATTESTATION_VERSION,
        "flavor": MANAGED_RUNTIME_WEBDEV_FLAVOR,
        "generation": lease_id.to_string(),
    })
}

fn attested_webdev_generation(metadata: Option<&JsonValue>) -> Option<Uuid> {
    let root = metadata?.as_object()?;
    let attestation = root.get(MANAGED_RUNTIME_LAUNCH_ATTESTATION)?.as_object()?;
    if attestation.get("version").and_then(JsonValue::as_u64)
        != Some(MANAGED_RUNTIME_LAUNCH_ATTESTATION_VERSION)
        || attestation.get("flavor").and_then(JsonValue::as_str)
            != Some(MANAGED_RUNTIME_WEBDEV_FLAVOR)
    {
        return None;
    }
    attestation
        .get("generation")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
}

pub(crate) fn managed_webdev_launch_is_attested(
    provider: &str,
    metadata: Option<&JsonValue>,
    lease_id: Uuid,
) -> bool {
    exact_managed_provider(provider) && attested_webdev_generation(metadata) == Some(lease_id)
}

/// Bind a newly selected managed flavor to the newly created lease generation.
pub(crate) fn attest_new_managed_runtime_launch(
    provider: &str,
    metadata: Option<JsonValue>,
    lease_id: Uuid,
) -> Option<JsonValue> {
    if !exact_managed_provider(provider) {
        return metadata;
    }

    let mut root = metadata_object(metadata);
    root.remove(MANAGED_RUNTIME_LAUNCH_ATTESTATION);
    if normalized_requested_flavor(&root).ok().flatten() == Some(MANAGED_RUNTIME_WEBDEV_FLAVOR) {
        root.insert(
            MANAGED_RUNTIME_LAUNCH_ATTESTATION.to_string(),
            launch_attestation(lease_id),
        );
    }
    Some(JsonValue::Object(root))
}

/// Reusing a live allocation must never change the image flavor that was
/// launched for its active lease. In particular, a later browser request may
/// not relabel a base image as webdev and gain controller consent without a
/// provider relaunch.
pub(crate) fn reconcile_reused_managed_runtime_metadata(
    provider: &str,
    requested: Option<JsonValue>,
    existing: Option<&JsonValue>,
    lease_id: Uuid,
) -> Result<Option<JsonValue>, &'static str> {
    if !exact_managed_provider(provider) {
        return Ok(requested);
    }

    let mut requested_root = metadata_object(requested);
    let requested_webdev =
        normalized_requested_flavor(&requested_root)? == Some(MANAGED_RUNTIME_WEBDEV_FLAVOR);
    let existing_webdev = managed_webdev_launch_is_attested(provider, existing, lease_id);
    if requested_webdev != existing_webdev {
        return Err(
            "managed runtime flavor does not match the active lease; stop it before changing flavor",
        );
    }

    requested_root.remove(MANAGED_RUNTIME_LAUNCH_ATTESTATION);
    if existing_webdev {
        requested_root.insert(
            MANAGED_RUNTIME_LAUNCH_ATTESTATION.to_string(),
            launch_attestation(lease_id),
        );
    }
    Ok(Some(JsonValue::Object(requested_root)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_turn::BrowserTurnRestConfig;
    use crate::runtime::provider::apply_controller_turn_credentials;

    const TEST_TURN_SECRET: &str = "managed-env-canonicalization-test-secret";

    #[test]
    fn shared_browser_consent_capability_requires_exact_attested_version() {
        assert!(runtime_supports_shared_browser_agent_consent(&json!({
            (SHARED_BROWSER_AGENT_CONSENT_CAPABILITY): {
                "version": SHARED_BROWSER_AGENT_CONSENT_VERSION,
            }
        })));
        for capabilities in [
            json!({}),
            json!({ (SHARED_BROWSER_AGENT_CONSENT_CAPABILITY): true }),
            json!({ (SHARED_BROWSER_AGENT_CONSENT_CAPABILITY): { "version": 0 } }),
            json!({ (SHARED_BROWSER_AGENT_CONSENT_CAPABILITY): { "version": 2 } }),
        ] {
            assert!(!runtime_supports_shared_browser_agent_consent(
                &capabilities
            ));
        }
    }

    #[test]
    fn exact_managed_request_fail_closes_env_and_top_level_allocator_controls() {
        let sanitized = sanitize_managed_runtime_request_metadata(
            "instafy-cloud",
            Some(json!({
                "runtimeFlavor": "webdev",
                "source": "browser-session",
                "runtimeImagePreset": "default",
                "sizeId": "boost",
                "runtimeAgentImage": "attacker/image:latest",
                "dockerComposeFile": "/tmp/attacker-compose.yml",
                "_instafyManagedRuntimeLaunch": {
                    "version": 1,
                    "flavor": "webdev",
                    "generation": Uuid::new_v4().to_string(),
                },
                "env": {
                    "RUNTIME_AGENT_IMAGE": "attacker/image:env",
                    "RUNTIME_CAPABILITIES": "{\"agent\":true}",
                    "INSTAFY_BROWSER_AGENT_CONTROL_FILE": "/tmp/attacker-control.json",
                    "INSTAFY_SHARED_BROWSER_APPROVAL_DIR": "/tmp/attacker-approvals",
                    "INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS": "60000",
                    "DOCKER_HOST": "tcp://attacker.test:2375",
                    "DOCKER_CONFIG": "/tmp/attacker-docker-config",
                    "COMPOSE_FILE": "/tmp/attacker-compose.yml",
                    "BUILDKIT_HOST": "tcp://attacker.test:1234",
                    "PATH": "/tmp/attacker-bin",
                    "BASH_ENV": "/tmp/attacker-shell-init",
                    "LD_PRELOAD": "/tmp/attacker.so",
                    "HTTP_PROXY": "http://attacker.test:8080",
                    "NO_PROXY": "controller.internal",
                    "PROXY_BASE_URL": "https://attacker.test/v1",
                    "RUNTIME_AGENT_BUILD_TARGET": "attacker-target",
                    "RUNTIME_AGENT_FORCE_BUILD": "1",
                    "CODEX_SANDBOX_MODE": "workspace-write",
                    "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                    "INSTAFY_BROWSER_VIEWPORT_ONLY": true,
                    "INSTAFY_BROWSER_WEBRTC_ENABLED": true,
                    "INSTAFY_VNC_PORT": 5900,
                    "INSTAFY_VNC_GEOMETRY": {"width": 1280},
                }
            })),
        )
        .expect("sanitize")
        .expect("metadata");

        assert_eq!(sanitized[MANAGED_RUNTIME_FLAVOR_KEY], "webdev");
        assert_eq!(sanitized["source"], "browser-session");
        assert_eq!(sanitized["runtimeImagePreset"], "default");
        assert_eq!(sanitized["sizeId"], "boost");
        assert!(sanitized.get("runtimeAgentImage").is_none());
        assert!(sanitized.get("dockerComposeFile").is_none());
        assert!(sanitized.get(MANAGED_RUNTIME_LAUNCH_ATTESTATION).is_none());
        for key in [
            "RUNTIME_AGENT_IMAGE",
            "RUNTIME_CAPABILITIES",
            "INSTAFY_BROWSER_AGENT_CONTROL_FILE",
            "INSTAFY_SHARED_BROWSER_APPROVAL_DIR",
            "INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS",
            "DOCKER_HOST",
            "DOCKER_CONFIG",
            "COMPOSE_FILE",
            "BUILDKIT_HOST",
            "PATH",
            "BASH_ENV",
            "LD_PRELOAD",
            "HTTP_PROXY",
            "NO_PROXY",
            "PROXY_BASE_URL",
            "RUNTIME_AGENT_BUILD_TARGET",
            "RUNTIME_AGENT_FORCE_BUILD",
            "CODEX_SANDBOX_MODE",
            "INSTAFY_VNC_GEOMETRY",
        ] {
            assert!(sanitized["env"].get(key).is_none(), "retained {key}");
        }
        assert_eq!(sanitized["env"]["INSTAFY_ENABLE_BROWSER_SESSION"], "1");
        assert_eq!(sanitized["env"]["INSTAFY_BROWSER_VIEWPORT_ONLY"], "1");
        assert_eq!(sanitized["env"]["INSTAFY_BROWSER_WEBRTC_ENABLED"], "1");
        assert_eq!(sanitized["env"]["INSTAFY_VNC_PORT"], "5900");
    }

    #[test]
    fn custom_and_self_hosted_metadata_remain_untouched() {
        for provider in ["acme-provider", "self-hosted", "instafy-cloud-custom"] {
            let supplied = json!({
                "runtimeAgentImage": "acme/runtime:one",
                "env": {
                    "RUNTIME_AGENT_IMAGE": "acme/runtime:two",
                    "RUNTIME_CAPABILITIES": "{\"custom\":true}",
                    "INSTAFY_SHARED_BROWSER_APPROVAL_DIR": "/srv/acme/approvals",
                    "DOCKER_HOST": "tcp://custom-docker.test:2375",
                    "PATH": "/srv/acme/bin",
                    "RUNTIME_AGENT_BUILD_TARGET": "runtime-custom",
                }
            });
            assert_eq!(
                sanitize_managed_runtime_request_metadata(provider, Some(supplied.clone()))
                    .expect("custom metadata"),
                Some(supplied),
            );
        }
    }

    #[test]
    fn boolean_webrtc_request_is_canonicalized_before_controller_policy() {
        let allowed_project = Uuid::new_v4();
        let denied_project = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let config = BrowserTurnRestConfig::for_test_projects(
            "turns:turn.example.test:443",
            TEST_TURN_SECRET,
            600,
            &allowed_project.to_string(),
        );
        let request = Some(json!({
            "env": {
                "INSTAFY_BROWSER_CDP_SCREENCAST": true,
                "INSTAFY_BROWSER_PREFERRED_VIEWER": "webrtc",
                "INSTAFY_BROWSER_WEBRTC_ENABLED": true,
                "INSTAFY_VNC_PORT": 5900
            }
        }));

        let sanitized = sanitize_managed_runtime_request_metadata("instafy-cloud", request.clone())
            .expect("managed request")
            .expect("managed metadata");
        assert_eq!(sanitized["env"]["INSTAFY_BROWSER_CDP_SCREENCAST"], "1");
        assert_eq!(sanitized["env"]["INSTAFY_BROWSER_WEBRTC_ENABLED"], "1");
        assert_eq!(sanitized["env"]["INSTAFY_VNC_PORT"], "5900");

        let denied = apply_controller_turn_credentials(
            Some(&config),
            denied_project,
            runtime_id,
            1_700_000_000,
            Some(sanitized.clone()),
        )
        .expect("denied metadata");
        assert_eq!(denied["env"]["INSTAFY_BROWSER_WEBRTC_ENABLED"], "0");
        assert_eq!(
            denied["env"]["INSTAFY_BROWSER_PREFERRED_VIEWER"],
            "cdp-screencast"
        );
        assert!(denied["env"]
            .get("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON")
            .is_none());
        assert!(denied["env"]
            .get("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN")
            .is_none());

        let allowed = apply_controller_turn_credentials(
            Some(&config),
            allowed_project,
            runtime_id,
            1_700_000_000,
            Some(sanitized),
        )
        .expect("allowed metadata");
        assert_eq!(allowed["env"]["INSTAFY_BROWSER_WEBRTC_ENABLED"], "1");
        assert_eq!(allowed["env"]["INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"], "1");
        assert!(allowed["env"]["INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"]
            .as_str()
            .is_some_and(|value| value.contains("turns:turn.example.test:443")));

        for provider in ["acme-provider", "self-hosted", "instafy-cloud-custom"] {
            assert_eq!(
                canonicalize_managed_runtime_env_values(provider, request.clone()),
                request,
                "custom provider metadata changed for {provider}"
            );
        }
    }

    #[test]
    fn new_launch_attestation_is_bound_to_exact_lease_generation() {
        let lease_id = Uuid::new_v4();
        let other_lease_id = Uuid::new_v4();
        let metadata = attest_new_managed_runtime_launch(
            "instafy-cloud",
            Some(json!({ "runtimeFlavor": "webdev" })),
            lease_id,
        );

        assert!(managed_webdev_launch_is_attested(
            "instafy-cloud",
            metadata.as_ref(),
            lease_id,
        ));
        assert!(!managed_webdev_launch_is_attested(
            "instafy-cloud",
            metadata.as_ref(),
            other_lease_id,
        ));
        assert!(!managed_webdev_launch_is_attested(
            "instafy-cloud-custom",
            metadata.as_ref(),
            lease_id,
        ));
    }

    #[test]
    fn active_base_generation_cannot_be_relabelled_as_webdev() {
        let lease_id = Uuid::new_v4();
        assert!(reconcile_reused_managed_runtime_metadata(
            "instafy-cloud",
            Some(json!({ "runtimeFlavor": "webdev" })),
            Some(&json!({ "runtimeFlavor": "default" })),
            lease_id,
        )
        .is_err());
    }

    #[test]
    fn active_webdev_generation_cannot_be_downgraded_or_spoofed() {
        let lease_id = Uuid::new_v4();
        let existing = attest_new_managed_runtime_launch(
            "instafy-cloud",
            Some(json!({ "runtimeFlavor": "webdev" })),
            lease_id,
        )
        .expect("attested metadata");

        assert!(reconcile_reused_managed_runtime_metadata(
            "instafy-cloud",
            Some(json!({})),
            Some(&existing),
            lease_id,
        )
        .is_err());

        let wrong_generation = attest_new_managed_runtime_launch(
            "instafy-cloud",
            Some(json!({ "runtimeFlavor": "webdev" })),
            Uuid::new_v4(),
        )
        .expect("wrong-generation metadata");
        assert!(reconcile_reused_managed_runtime_metadata(
            "instafy-cloud",
            Some(json!({ "runtimeFlavor": "webdev" })),
            Some(&wrong_generation),
            lease_id,
        )
        .is_err());
    }
}
