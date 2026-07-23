use std::ffi::OsString;

/// Runtime/service credentials that must never cross into a model-controlled
/// subprocess. The verified per-job `CONTROLLER_ACCESS_TOKEN` and the proxy
/// envelope API keys are intentionally not included here.
pub(crate) const INTERNAL_CREDENTIAL_ENV_KEYS: &[&str] = &[
    // Runtime, origin, and interactive launcher credentials.
    "RUNTIME_ACCESS_TOKEN",
    "RUNTIME_TOKEN",
    "ORIGIN_INTERNAL_TOKEN",
    "ORIGIN_ACCESS_TOKEN",
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
    "PROGRESS_CALLBACK_SECRET",
    "SUPABASE_JWT_SECRET",
    "USER_TOKEN_SECRET",
    "RUNTIME_SIGNING_PRIVATE_KEY",
    "RUNTIME_SIGNING_PRIVATE_KEY_B64",
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
];

/// Credentials the parent runtime must retain for in-process features but a
/// model-controlled subprocess must never inherit.
pub(crate) const MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS: &[&str] =
    &["INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"];

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
    fn webrtc_ice_credentials_are_model_internal_credentials() {
        assert!(is_model_child_excluded_env_key(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"
        ));
        assert!(!is_internal_credential_env_key(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"
        ));
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
    fn runtime_compose_files_drop_ptrace_capability() {
        for compose in [
            include_str!("../../../docker/docker-compose.runtime.yml"),
            include_str!("../../../docker/docker-compose.runtime.provider.yml"),
        ] {
            assert_eq!(
                compose.matches("      - SYS_PTRACE").count(),
                1,
                "runtime service must explicitly drop SYS_PTRACE exactly once"
            );
        }
    }
}
