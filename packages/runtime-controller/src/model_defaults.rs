use runtime_contracts::own_ai_model::OWN_AI_SMALL_MODEL_ID;

pub const DEFAULT_MANAGED_AI_PROVIDER_ID: &str = "openai";

/// Default model for bring-your-own OpenAI credentials: API keys without a
/// provider hint and ChatGPT logins (`codex_auth_json`). Those users pay by
/// subscription or their own key, so the stronger Sol tier is the right default.
/// This is also what older full-size picks run (`own_ai_model_floor`). The id
/// lives in `runtime_contracts::own_ai_model`, shared with the runtime.
pub use runtime_contracts::own_ai_model::OWN_AI_DEFAULT_MODEL_ID as DEFAULT_OPENAI_MODEL_ID;

/// Default model for the operator-paid managed "Instafy AI" tier (credits).
/// GPT-6 Luna is priced at $0.10 / $0.01 cached / $0.50 per 1M tokens (public
/// price pages, 2026-09-22), versus GPT-6 Sol at $2 / $0.20 / $10. Managed
/// turns are charged to the shared team balance, so the cheaper model is the
/// default; operators override it with `MANAGED_AI_MODEL_ID`.
pub const DEFAULT_MANAGED_AI_MODEL_ID: &str = "gpt-6-luna";
pub const DEFAULT_MANAGED_AI_MODEL_LABEL: &str = "GPT-6 Luna";

/// Reasoning effort for a chat turn (intent `feature`) on the managed tier,
/// Shared Browser and Personal Browser turns included, unless
/// `MANAGED_AI_CHAT_REASONING_EFFORT` says otherwise. The runtime runs such a
/// turn at `high` by default; managed turns are charged to the shared team
/// balance, so they run one step lower. A person's own login or key keeps the
/// runtime's default, and an agent's own reasoning setting still wins.
pub const DEFAULT_MANAGED_AI_CHAT_REASONING_EFFORT: &str = "medium";

/// Managed-tier list prices in USD micros per 1K tokens, matching
/// `DEFAULT_MANAGED_AI_MODEL_ID`. 100 micros per 1K tokens is $0.10 per 1M.
pub const DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K: i64 = 100;
pub const DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K: i64 = 10;
pub const DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K: i64 = 500;

pub const DEFAULT_DEEPSEEK_MODEL_ID: &str = "deepseek-chat";
pub const DEFAULT_ZAI_MODEL_ID: &str = "glm-5";
pub const DEFAULT_GEMINI_MODEL_ID: &str = "gemini-2.5-pro";

/// Managed "Instafy AI" tier default (operator-paid, credits). Not the default
/// for user-owned credentials; see `default_chatgpt_model_id`.
pub fn default_managed_ai_model_id() -> &'static str {
    DEFAULT_MANAGED_AI_MODEL_ID
}

pub fn default_managed_ai_model_label() -> &'static str {
    DEFAULT_MANAGED_AI_MODEL_LABEL
}

/// Default for a bring-your-own ChatGPT login (`codex_auth_json`). The user pays
/// by subscription, so this deliberately stays on Sol rather than tracking the
/// managed tier.
pub fn default_chatgpt_model_id() -> &'static str {
    DEFAULT_OPENAI_MODEL_ID
}

pub fn default_model_for_provider(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "deepseek" => DEFAULT_DEEPSEEK_MODEL_ID,
        "zai" => DEFAULT_ZAI_MODEL_ID,
        "gemini" | "google" | "google-ai" | "google_gemini" | "google-gemini" => {
            DEFAULT_GEMINI_MODEL_ID
        }
        _ => DEFAULT_OPENAI_MODEL_ID,
    }
}

pub fn default_agent_model_for_provider(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "deepseek" => Some(DEFAULT_DEEPSEEK_MODEL_ID),
        "zai" => Some(DEFAULT_ZAI_MODEL_ID),
        "gemini" | "google" | "google-ai" | "google_gemini" | "google-gemini" => {
            Some(DEFAULT_GEMINI_MODEL_ID)
        }
        _ => None,
    }
}

pub fn agent_model_is_compatible_with_provider(provider: &str, model: &str) -> bool {
    let provider = provider.trim().to_ascii_lowercase();
    let model = model.trim().to_ascii_lowercase();
    if model.is_empty() {
        return false;
    }

    match provider.as_str() {
        "deepseek" => model.starts_with("deepseek-"),
        "zai" => model.starts_with("glm-"),
        "gemini" | "google" | "google-ai" | "google_gemini" | "google-gemini" => {
            model.starts_with("gemini-")
        }
        _ => {
            !model.starts_with("deepseek-")
                && !model.starts_with("glm-")
                && !model.starts_with("gemini-")
        }
    }
}

/// What a person's own OpenAI pick runs: any bare OpenAI id below GPT-6
/// (`gpt-N` with N < 6, and `o<digit>` reasoning models) is raised to the
/// own-AI default, or to its small tier when the id names a Luna, mini or nano
/// model. Retired ids (`runtime_contracts::own_ai_model::is_retired_openai_model`)
/// are below GPT-6, so this covers them too. GPT-6 and later, ids without a
/// version and namespaced ids (`openai/gpt-5.5`) return `None` and run as
/// picked.
///
/// Owner decision 2026-10-26: own AI runs at least GPT-6. Saved agents and
/// credentials keep the id they were created with, so the floor is applied
/// when a job or lease is built, not by rewriting rows. The managed lane never
/// passes through here: its model is the operator's `MANAGED_AI_MODEL_ID`.
pub fn own_ai_model_floor(model: &str) -> Option<&'static str> {
    let normalized = model.trim().to_ascii_lowercase();
    let after_version = if let Some(rest) = normalized.strip_prefix("gpt-") {
        let major: String = rest
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        if major.parse::<u32>().ok()? >= 6 {
            return None;
        }
        &rest[major.len()..]
    } else {
        let rest = normalized.strip_prefix('o')?;
        if !rest.starts_with(|character: char| character.is_ascii_digit()) {
            return None;
        }
        rest
    };
    let small = after_version
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|part| matches!(part, "luna" | "mini" | "nano"));
    Some(if small {
        OWN_AI_SMALL_MODEL_ID
    } else {
        DEFAULT_OPENAI_MODEL_ID
    })
}

/// A person's own-AI model as it runs on `provider`: raised by
/// [`own_ai_model_floor`] on OpenAI-like providers (those without an agent
/// default), unchanged on DeepSeek, z.ai and Gemini.
pub fn floor_own_ai_model_for_provider(provider: &str, model: &str) -> String {
    let model = model.trim();
    if default_agent_model_for_provider(provider).is_none() {
        if let Some(floor) = own_ai_model_floor(model) {
            return floor.to_string();
        }
    }
    model.to_string()
}

pub fn resolve_agent_model_for_provider(
    provider: &str,
    configured_model: Option<String>,
) -> Option<String> {
    if let Some(model) = configured_model {
        let normalized = model.trim();
        if agent_model_is_compatible_with_provider(provider, normalized) {
            return Some(floor_own_ai_model_for_provider(provider, normalized));
        }
    }

    default_agent_model_for_provider(provider).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        agent_model_is_compatible_with_provider, default_chatgpt_model_id,
        default_managed_ai_model_id, default_managed_ai_model_label, default_model_for_provider,
        floor_own_ai_model_for_provider, own_ai_model_floor, resolve_agent_model_for_provider,
        DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K,
        DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K, DEFAULT_MANAGED_AI_MODEL_ID,
        DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K, DEFAULT_OPENAI_MODEL_ID,
    };
    use runtime_contracts::own_ai_model::{is_retired_openai_model, OWN_AI_SMALL_MODEL_ID};
    use serde_json::Value;

    /// The own-AI ids and floor cases, shared with the proxy's and Studio's
    /// tests (runtime-contracts `own_ai_model_fixtures.json`).
    fn fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../runtime-contracts/src/own_ai_model_fixtures.json"
        ))
        .expect("fixtures")
    }

    /// A fixture's symbolic target: `default`, `small`, or `keep` (no floor).
    fn floor_target(runs: &str) -> Option<&'static str> {
        match runs {
            "default" => Some(DEFAULT_OPENAI_MODEL_ID),
            "small" => Some(OWN_AI_SMALL_MODEL_ID),
            "keep" => None,
            other => panic!("unknown floor target {other}"),
        }
    }

    #[test]
    fn managed_tier_defaults_to_luna_while_byo_credentials_run_sol() {
        // Owner decision 2026-09-17: only the operator-paid managed tier moves
        // to Luna. ChatGPT logins, API keys, and the stale-model floor stay on Sol.
        // 2026-09-22: the managed tier follows Luna to GPT-6 Luna on its release.
        // 2026-10-26: own AI moves to GPT-6 Sol; Instafy AI stays on GPT-6 Luna.
        assert_eq!(default_managed_ai_model_id(), "gpt-6-luna");
        assert_eq!(default_managed_ai_model_label(), "GPT-6 Luna");
        assert_eq!(fixtures()["defaultModelId"], DEFAULT_OPENAI_MODEL_ID);
        assert_eq!(default_chatgpt_model_id(), DEFAULT_OPENAI_MODEL_ID);
        assert_eq!(
            default_model_for_provider("openai"),
            DEFAULT_OPENAI_MODEL_ID
        );
        assert_eq!(default_model_for_provider(""), DEFAULT_OPENAI_MODEL_ID);
        assert_ne!(default_managed_ai_model_id(), default_chatgpt_model_id());
    }

    #[test]
    fn managed_tier_price_defaults_match_luna_list_prices() {
        // GPT-6 Luna standard-tier list prices, verified 2026-09-22. USD micros
        // per 1K tokens: 100 is $0.10 per 1M, 10 is $0.01, 500 is $0.50. The rates
        // must move with DEFAULT_MANAGED_AI_MODEL_ID or users are billed for the
        // wrong model.
        assert_eq!(DEFAULT_MANAGED_AI_MODEL_ID, "gpt-6-luna");
        assert_eq!(DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K, 100);
        assert_eq!(DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K, 10);
        assert_eq!(DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K, 500);
    }

    #[test]
    fn own_ai_picks_below_gpt_6_run_the_fixtures_floor() {
        for case in fixtures()["floor"].as_array().expect("floor cases") {
            let model = case["model"].as_str().expect("model");
            let expected = floor_target(case["runs"].as_str().expect("runs"));
            assert_eq!(own_ai_model_floor(model), expected, "{model:?}");
            assert_eq!(
                resolve_agent_model_for_provider("openai", Some(model.to_string())).as_deref(),
                Some(expected.unwrap_or(model.trim())),
                "{model:?} as an agent's model"
            );
        }
        // Every id the runtime retires is raised here first.
        for retired in fixtures()["retired"].as_array().expect("retired ids") {
            let retired = retired.as_str().expect("model id");
            assert!(is_retired_openai_model(retired), "{retired}");
            assert!(own_ai_model_floor(retired).is_some(), "{retired}");
        }
        // The floor never lands below itself.
        assert_eq!(own_ai_model_floor(DEFAULT_OPENAI_MODEL_ID), None);
        assert_eq!(own_ai_model_floor(OWN_AI_SMALL_MODEL_ID), None);
    }

    #[test]
    fn the_floor_applies_only_to_openai_like_providers() {
        // An agent on the managed tier's model runs it as picked: if the floor
        // ever tightened to "anything but Sol", every such agent would be
        // silently moved to Sol.
        assert_eq!(own_ai_model_floor(DEFAULT_MANAGED_AI_MODEL_ID), None);
        assert_eq!(
            resolve_agent_model_for_provider(
                "openai",
                Some(DEFAULT_MANAGED_AI_MODEL_ID.to_string())
            )
            .as_deref(),
            Some("gpt-6-luna")
        );
        // "assistant" agents follow the OpenAI path; other providers keep their ids.
        assert_eq!(
            floor_own_ai_model_for_provider("assistant", " gpt-5.6-sol "),
            DEFAULT_OPENAI_MODEL_ID
        );
        assert_eq!(
            floor_own_ai_model_for_provider("deepseek", " deepseek-chat "),
            "deepseek-chat"
        );
        assert_eq!(floor_own_ai_model_for_provider("zai", "glm-5"), "glm-5");
        assert_eq!(
            floor_own_ai_model_for_provider("gemini", "gemini-2.5-pro"),
            "gemini-2.5-pro"
        );
    }

    #[test]
    fn agent_model_compatibility_keeps_provider_specific_ids_scoped() {
        assert!(agent_model_is_compatible_with_provider("openai", "gpt-5.5"));
        assert!(agent_model_is_compatible_with_provider("openai", "o3-mini"));
        assert!(!agent_model_is_compatible_with_provider(
            "openai", "glm-4.5"
        ));
        assert!(!agent_model_is_compatible_with_provider(
            "openai",
            "deepseek-reasoner"
        ));
        assert!(!agent_model_is_compatible_with_provider(
            "openai",
            "gemini-2.5-pro"
        ));

        assert!(agent_model_is_compatible_with_provider("zai", "glm-5"));
        assert!(!agent_model_is_compatible_with_provider("zai", "gpt-5.4"));
        assert!(agent_model_is_compatible_with_provider(
            "deepseek",
            "deepseek-reasoner"
        ));
        assert!(agent_model_is_compatible_with_provider(
            "gemini",
            "gemini-2.5-pro"
        ));
    }

    #[test]
    fn resolve_agent_model_falls_back_when_stale_model_crosses_provider() {
        assert_eq!(
            resolve_agent_model_for_provider("openai", Some("glm-4.5".to_string())),
            None
        );
        assert_eq!(
            resolve_agent_model_for_provider("zai", Some("gpt-5.5".to_string())).as_deref(),
            Some("glm-5")
        );
        assert_eq!(
            resolve_agent_model_for_provider("gemini", Some("glm-4.5".to_string())).as_deref(),
            Some("gemini-2.5-pro")
        );
        assert_eq!(
            resolve_agent_model_for_provider("deepseek", Some("gpt-5.5".to_string())).as_deref(),
            Some("deepseek-chat")
        );
    }
}
