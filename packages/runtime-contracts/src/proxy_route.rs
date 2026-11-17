//! The proxy route: the environment that sends a turn's model traffic through
//! the Instafy proxy.
//!
//! For each turn the runtime agent sets the turn's proxy grant as
//! `OPENAI_API_KEY` and `CODEX_API_KEY`, and the proxy's addresses as the other
//! names, from the turn's proxy envelope. A runtime's launch environment may set
//! `PROXY_BASE_URL` to say where the runtime reaches the proxy, and the agent
//! reads it as it sets the rest. The turn's engine, its direct worker lanes and
//! every command the model runs read these values from the agent's process
//! environment, where a sequential job's project secrets are set too.
//!
//! A project secret under one of these names would send the turn's model
//! traffic, with its grant, to an address a project member chose. So the
//! controller refuses to save a project secret under one of these names and
//! never delivers one stored earlier, and the runtime agent never sets one from
//! a job's secrets (docs/Settings-UI.md, Secrets).

/// The names, as the controller writes a project secret's name.
pub const PROXY_ROUTE_ENV_KEYS: [&str; 7] = [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_ENDPOINT",
    "CODEX_CHATGPT_ENDPOINT",
    "CODEX_PROXY_CHATGPT_ENDPOINT",
    "PROXY_BASE_URL",
];

/// Whether `name` is one of [`PROXY_ROUTE_ENV_KEYS`] in any ASCII letter case,
/// since some platforms match environment names without regard to case.
pub fn is_proxy_route_env_key(name: &str) -> bool {
    PROXY_ROUTE_ENV_KEYS
        .iter()
        .any(|key| key.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_names_are_matched_in_any_letter_case_and_nothing_else() {
        for name in PROXY_ROUTE_ENV_KEYS {
            assert!(is_proxy_route_env_key(name), "{name}");
            assert!(is_proxy_route_env_key(&name.to_ascii_lowercase()), "{name}");
        }
        assert!(is_proxy_route_env_key("Openai_Base_Url"));
        for name in [
            "",
            "OPENAI_API_KEY_2",
            "APP_OPENAI_API_KEY",
            "OPENAI_API_BASE",
            "OPENAI_ORG_ID",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "PROXY_BASE",
            "HTTPS_PROXY",
            "CODEX_MODEL",
            " OPENAI_API_KEY",
        ] {
            assert!(!is_proxy_route_env_key(name), "{name:?}");
        }
    }
}
