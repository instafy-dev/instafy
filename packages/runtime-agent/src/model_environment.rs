use std::ffi::OsString;

/// Runtime/service credentials that must never cross into a model-controlled
/// subprocess. The verified per-job `CONTROLLER_ACCESS_TOKEN` and the proxy
/// envelope API keys are intentionally not included here.
pub(crate) const INTERNAL_CREDENTIAL_ENV_KEYS: &[&str] = &[
    // Launch credentials: the first `LAUNCH_CREDENTIAL_KEY_COUNT` entries.
    "RUNTIME_ACCESS_TOKEN",
    "RUNTIME_TOKEN",
    "ORIGIN_INTERNAL_TOKEN",
    "ORIGIN_ACCESS_TOKEN",
    // Other runtime, origin, and interactive launcher credentials.
    "ORIGIN_TOKEN",
    "WORKSPACE_ACCESS_TOKEN",
    "WORKSPACE_INTERNAL_TOKEN",
    "WORKSPACE_TOKEN",
    "CONTROLLER_WORKSPACE_TOKEN",
    "INSTAFY_WORKSPACE_TOKEN",
    "CONTROLLER_INTERNAL_TOKEN",
    "CONTROLLER_TOKEN",
    "CONTROLLER_BEARER",
    "CONTROLLER_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_ROLE_KEY",
    "SUPABASE_ACCESS_TOKEN",
    "INSTAFY_ACCESS_TOKEN",
    "INSTAFY_SERVICE_TOKEN",
    "AGENT_LOGIN_KEY",
    "AGENT_KEY",
    // Proxy/controller signing and callback credentials.
    "PROXY_SIGNING_SECRET",
    "CONTROLLER_BROWSER_TURN_SHARED_SECRET",
    "CREDENTIAL_ENCRYPTION_KEY",
    "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS",
    "PROGRESS_CALLBACK_SECRET",
    "SUPABASE_JWT_SECRET",
    "USER_TOKEN_SECRET",
    "RUNTIME_SIGNING_PRIVATE_KEY",
    "RUNTIME_SIGNING_PRIVATE_KEY_B64",
    // The controller-to-proxy bearer for credential leases and the platform
    // model key. Only the proxy reads them; a model holding either could
    // fetch provider credentials or call a model provider around the proxy.
    "PROXY_CREDENTIAL_LEASE_TOKEN",
    "MANAGED_AI_OPENAI_API_KEY",
    // Other controller-only credentials an operator shell may carry into a
    // locally launched runtime.
    "SERVICE_RUNTIME_USER_PASSWORD",
    "DESKTOP_RELEASE_GITHUB_TOKEN",
    "WEB_PUSH_VAPID_PRIVATE_KEY",
    // Runtime allocator/provider credentials.
    "PROVIDER_AUTH_TOKEN",
    "DEV_PROVIDER_AUTH_TOKEN",
    "RUNTIME_PROVIDER_AUTH_TOKEN",
    "HETZNER_PROVIDER_AUTH_TOKEN",
    "DOCKER_POOL_AUTH_TOKEN",
    "HCLOUD_TOKEN",
    "HETZNER_TOKEN",
    "PDNS_API_KEY",
    // Git service credentials.
    "GIT_EDGE_CONTROLLER_TOKEN",
    "GIT_EVENTS_WEBHOOK_TOKEN",
    "GIT_EVENT_HOOK_SECRET",
    // Tunnel broker/server credentials.
    "TUNNEL_BROKER_TOKEN",
    "TUNNEL_BROKER_HOOK_SECRET",
    "BROKER_API_TOKENS",
    "RATHOLE_SHARED_TOKEN",
    "TOKEN_SIGNING_KEY",
    "ACL_HOOK_TOKEN",
    "EVENT_HOOK_TOKEN",
    // Codex workload identity. When present, Codex exchanges this identity for
    // OpenAI credentials directly, which would route model traffic around the
    // Instafy proxy's per-job key.
    "OPENAI_FEDERATION_RULE_ID",
    "OPENAI_IDENTITY_TOKEN_FILE",
    "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
];

const LAUNCH_CREDENTIAL_KEY_COUNT: usize = 4;

/// Credentials a launcher hands the runtime agent so it can register and start
/// its origin. The agent keeps the ones its configuration reads and then
/// removes all of them from its own environment
/// (`config::capture_and_scrub_launch_credentials`), so no process it spawns
/// inherits them.
pub(crate) const LAUNCH_CREDENTIAL_ENV_KEYS: &[&str] = INTERNAL_CREDENTIAL_ENV_KEYS
    .split_at(LAUNCH_CREDENTIAL_KEY_COUNT)
    .0;

/// Values the parent runtime must retain for in-process features but a
/// model-controlled subprocess must never inherit.
///
/// `RUNTIME_METADATA` is the launch metadata, read once by
/// `Config::from_env`. It repeats the launch `env` object, which can carry
/// `INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON` and its TURN credentials, and any
/// later controller attestation, so it is withheld as a whole.
pub(crate) const MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS: &[&str] = &[
    "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
    "RUNTIME_METADATA",
];

/// Non-secret process settings that persistent helper processes may inherit.
/// Callers add the smallest feature-specific set on top of this baseline.
pub(crate) const PERSISTENT_HELPER_BASE_ENV_KEYS: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "COLORTERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

pub(crate) const BROWSER_HELPER_ENV_KEYS: &[&str] = &[
    "WORKSPACE_DIR",
    "CODEX_HOME",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "NODE_PATH",
    "INSTAFY_ENABLE_BROWSER_SESSION",
    "INSTAFY_PLAYWRIGHT_PROFILE_DIR",
    "INSTAFY_PLAYWRIGHT_CDP_PORT",
    "INSTAFY_BROWSER_ACTIONS_FILE",
    "INSTAFY_BROWSER_EGRESS_ISOLATION",
    "INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV",
    "INSTAFY_BROWSER_EGRESS_PROXY_BIND",
    "INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS",
    "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS",
    "INSTAFY_BROWSER_RENDER_SCALE",
    "INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS",
    "INSTAFY_BROWSER_VIEWPORT_ONLY",
    "INSTAFY_BROWSER_ADBLOCK",
    "INSTAFY_VNC_GEOMETRY",
];

pub(crate) const TERMINAL_HELPER_ENV_KEYS: &[&str] = &[
    "CARGO_HOME",
    "RUSTUP_HOME",
    "GOPATH",
    "PIP_CACHE_DIR",
    "UV_CACHE_DIR",
    "npm_config_cache",
    "NODE_PATH",
    "SPACE_ID",
    "INSTAFY_SPACE_ID",
    "PROJECT_ID",
    "INSTAFY_PROJECT_ID",
    "CONVERSATION_ID",
    "INSTAFY_CONVERSATION_ID",
];

pub(crate) fn is_internal_credential_env_key(candidate: &str) -> bool {
    INTERNAL_CREDENTIAL_ENV_KEYS
        .iter()
        .any(|key| candidate.eq_ignore_ascii_case(key))
}

pub(crate) fn is_model_child_excluded_env_key(candidate: &str) -> bool {
    is_internal_credential_env_key(candidate)
        || MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS
            .iter()
            .any(|key| candidate.eq_ignore_ascii_case(key))
}

fn allowlisted_environment(extra_keys: &[&str]) -> Vec<(OsString, OsString)> {
    PERSISTENT_HELPER_BASE_ENV_KEYS
        .iter()
        .copied()
        .chain(extra_keys.iter().copied())
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

#[cfg(test)]
pub(crate) fn apply_allowlisted_std_environment(
    command: &mut std::process::Command,
    extra_keys: &[&str],
) {
    command.env_clear();
    command.envs(allowlisted_environment(extra_keys));
}

pub(crate) fn apply_allowlisted_tokio_environment(
    command: &mut tokio::process::Command,
    extra_keys: &[&str],
) {
    command.env_clear();
    command.envs(allowlisted_environment(extra_keys));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_helper_environment_is_positive_allowlist_only() {
        const TEST_SECRET: &str = "INSTAFY_TEST_PERSISTENT_HELPER_SECRET";
        const FORBIDDEN_KEYS: &[&str] = &[
            "CONTROLLER_ACCESS_TOKEN",
            "CONTROLLER_TOKEN",
            "CONTROLLER_BEARER",
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "GITHUB_TOKEN",
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
        ];
        struct RestoreEnvironment(Option<OsString>);
        impl Drop for RestoreEnvironment {
            fn drop(&mut self) {
                unsafe {
                    if let Some(value) = self.0.take() {
                        std::env::set_var(TEST_SECRET, value);
                    } else {
                        std::env::remove_var(TEST_SECRET);
                    }
                }
            }
        }
        let _restore = RestoreEnvironment(std::env::var_os(TEST_SECRET));
        unsafe {
            std::env::set_var(TEST_SECRET, "must-not-leak");
        }
        let mut command = std::process::Command::new("env");
        command.env("CONTROLLER_TOKEN", "poisoned-controller-token");
        command.env("CONTROLLER_BEARER", "poisoned-controller-bearer");
        apply_allowlisted_std_environment(&mut command, TERMINAL_HELPER_ENV_KEYS);
        let output = command.output().expect("run env probe");
        assert!(output.status.success());
        let inherited = String::from_utf8_lossy(&output.stdout);
        assert!(
            !inherited
                .lines()
                .any(|line| line.starts_with(&format!("{TEST_SECRET}=")))
        );
        for key in FORBIDDEN_KEYS {
            assert!(!PERSISTENT_HELPER_BASE_ENV_KEYS.contains(key));
            assert!(!TERMINAL_HELPER_ENV_KEYS.contains(key));
        }
        for key in INTERNAL_CREDENTIAL_ENV_KEYS {
            assert!(
                !inherited
                    .lines()
                    .any(|line| line.starts_with(&format!("{key}="))),
                "persistent helper inherited internal credential {key}"
            );
        }
    }

    #[test]
    fn controller_credential_keys_are_internal_credentials() {
        // Every key that opens stored secrets, including the decrypt-only
        // keys kept during a rotation, stays out of runtime children.
        for key in [
            "CREDENTIAL_ENCRYPTION_KEY",
            "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS",
            "credential_encryption_previous_keys",
        ] {
            assert!(is_internal_credential_env_key(key), "{key}");
            assert!(is_model_child_excluded_env_key(key), "{key}");
        }
    }

    #[test]
    fn codex_workload_identity_keys_are_internal_credentials() {
        // A job scrubs these before Codex initializes its auth manager, so a
        // runtime environment cannot switch Codex onto workload identity.
        for key in codex_protocol::shell_environment::NON_INHERITABLE_ENV_VARS
            .iter()
            .filter(|key| key.starts_with("OPENAI_"))
        {
            assert!(is_internal_credential_env_key(key), "{key}");
            assert!(is_model_child_excluded_env_key(key), "{key}");
        }
        for key in [
            codex_protocol::shell_environment::OPENAI_FEDERATION_RULE_ID_ENV_VAR,
            codex_protocol::shell_environment::OPENAI_IDENTITY_TOKEN_FILE_ENV_VAR,
        ] {
            assert!(is_internal_credential_env_key(key), "{key}");
        }
    }

    #[test]
    fn webrtc_ice_credentials_are_model_internal_credentials() {
        assert!(is_model_child_excluded_env_key(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"
        ));
        assert!(!is_internal_credential_env_key(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"
        ));
    }

    #[test]
    fn runtime_launch_metadata_stays_with_the_agent() {
        // The agent reads the launch metadata at startup, so the job-time
        // scrub of internal credentials must leave it in place; model
        // children must never see it, in any case spelling.
        for key in ["RUNTIME_METADATA", "runtime_metadata", "Runtime_Metadata"] {
            assert!(is_model_child_excluded_env_key(key), "{key}");
            assert!(!is_internal_credential_env_key(key), "{key}");
        }
        assert!(!LAUNCH_CREDENTIAL_ENV_KEYS.contains(&"RUNTIME_METADATA"));
        // Its non-secret siblings stay visible to the model's tooling.
        for key in [
            "RUNTIME_ID",
            "RUNTIME_LEASE_ID",
            "RUNTIME_CAPABILITIES",
            "ORIGIN_METADATA",
            "ORIGIN_GIT_REMOTE_URL",
        ] {
            assert!(!is_model_child_excluded_env_key(key), "{key}");
        }
    }

    #[test]
    fn proxy_and_controller_only_credentials_are_internal_credentials() {
        for key in [
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "MANAGED_AI_OPENAI_API_KEY",
            "SERVICE_RUNTIME_USER_PASSWORD",
            "DESKTOP_RELEASE_GITHUB_TOKEN",
            "WEB_PUSH_VAPID_PRIVATE_KEY",
        ] {
            assert!(is_internal_credential_env_key(key), "{key}");
            assert!(is_model_child_excluded_env_key(key), "{key}");
            assert!(!LAUNCH_CREDENTIAL_ENV_KEYS.contains(&key), "{key}");
        }
        // The per-job controller token and the proxy envelope keys are how a
        // model shell legitimately reaches the controller and the proxy.
        for key in ["CONTROLLER_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"] {
            assert!(!is_model_child_excluded_env_key(key), "{key}");
        }
    }

    #[test]
    fn runtime_compose_files_forward_launch_metadata_only_to_the_agent() {
        // The compose files hand the runtime its launch metadata; this test
        // pins the name the exclusion above must match.
        for compose in [
            include_str!("../../../docker/docker-compose.runtime.yml"),
            include_str!("../../../docker/docker-compose.runtime.provider.yml"),
        ] {
            assert!(
                compose
                    .lines()
                    .any(|line| line.trim() == "RUNTIME_METADATA: ${RUNTIME_METADATA:-}"),
                "runtime compose no longer forwards RUNTIME_METADATA under the excluded name"
            );
        }
    }

    #[test]
    fn runtime_entrypoint_positive_allowlists_every_persistent_browser_helper() {
        let entrypoint = include_str!("../../../docker/runtime/entrypoint.sh");
        for spawn in [
            "env -i \"${MODEL_SAFE_ENV[@]}\" browser-egress-proxy",
            "env -i \"${MODEL_SAFE_ENV[@]}\" browser-webrtc-sender",
            "env -i \"${MODEL_SAFE_ENV[@]}\" \"${chrome_path}\"",
            "env -i \"${MODEL_SAFE_ENV[@]}\" Xtigervnc",
            "env -i \"${MODEL_SAFE_ENV[@]}\" fluxbox",
        ] {
            assert!(
                entrypoint.contains(spawn),
                "persistent browser helper is missing positive env allowlist: {spawn}"
            );
        }
        assert!(
            !entrypoint.contains("while true; do\n      exit_code=0\n      browser-webrtc-sender"),
            "TURN credentials must not live in a dumpable bash restart loop"
        );
    }

    #[test]
    fn runtime_compose_files_drop_ptrace_and_raw_socket_capabilities() {
        for compose in [
            include_str!("../../../docker/docker-compose.runtime.yml"),
            include_str!("../../../docker/docker-compose.runtime.provider.yml"),
        ] {
            for capability in ["SYS_PTRACE", "NET_RAW"] {
                let entry = format!("      - {capability}");
                assert_eq!(
                    compose
                        .lines()
                        .filter(|line| line.trim_end() == entry)
                        .count(),
                    1,
                    "runtime service must explicitly drop {capability} exactly once"
                );
            }
        }
    }

    #[test]
    fn launch_credentials_are_the_runtime_and_origin_launch_tokens() {
        assert_eq!(
            LAUNCH_CREDENTIAL_ENV_KEYS,
            [
                "RUNTIME_ACCESS_TOKEN",
                "RUNTIME_TOKEN",
                "ORIGIN_INTERNAL_TOKEN",
                "ORIGIN_ACCESS_TOKEN",
            ]
        );
    }
}
