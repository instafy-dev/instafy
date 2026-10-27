use runtime_contracts::own_ai_model::own_ai_model_floor;

pub const DEFAULT_MANAGED_AI_PROVIDER_ID: &str = "openai";

/// Default model for bring-your-own OpenAI credentials: API keys without a
/// provider hint and ChatGPT logins (`codex_auth_json`). Those users pay by
/// subscription or their own key, so the stronger Sol tier is the right default.
/// It is also the least their OpenAI picks run (`own_ai_model_floor`). The id
/// and the floor live in `runtime_contracts::own_ai_model`, shared with the
/// runtime.
pub use runtime_contracts::own_ai_model::OWN_AI_DEFAULT_MODEL_ID as DEFAULT_OPENAI_MODEL_ID;

/// Default model for the operator-paid managed "Instafy AI" tier (credits).
/// GPT-6 Luna is priced at $0.10 / $0.01 cached / $0.50 per 1M tokens (public
/// price pages, 2026-09-22), versus the own-AI default GPT-6.1 Sol at $2 /
/// $0.10 / $10 (docs/Credits-Billing.md). Managed
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

/// A person's own-AI model as it runs on `provider`: raised by
/// `runtime_contracts::own_ai_model::own_ai_model_floor` on OpenAI-like
/// providers (those without an agent default), unchanged on DeepSeek, z.ai and
/// Gemini.
///
/// Owner decisions 2026-10-26 and 2026-10-27: own AI runs at least the own-AI
/// default (GPT-6.1 Sol), except GPT-6 Luna when a person picks it on purpose
/// as the cheaper model (`OWN_AI_SMALL_MODEL_ID`), while Instafy AI stays on
/// GPT-6 Luna. Saved agents and credentials
/// keep the id they were created with, so this is applied when a job or lease
/// is built, not by rewriting rows. The managed lane never passes through
/// here: its model is the operator's `MANAGED_AI_MODEL_ID`.
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
        floor_own_ai_model_for_provider, resolve_agent_model_for_provider,
        DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K,
        DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K, DEFAULT_MANAGED_AI_MODEL_ID,
        DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K, DEFAULT_OPENAI_MODEL_ID,
    };
    use runtime_contracts::own_ai_model::{own_ai_model_floor, OWN_AI_SMALL_MODEL_ID};

    #[test]
    fn managed_tier_defaults_to_luna_while_byo_credentials_run_sol() {
        // Owner decision 2026-09-17: only the operator-paid managed tier moves
        // to Luna. ChatGPT logins, API keys, and the stale-model floor stay on Sol.
        // 2026-09-22: the managed tier follows Luna to GPT-6 Luna on its release.
        // 2026-10-26: own AI moves to GPT-6 Sol; Instafy AI stays on GPT-6 Luna.
        // 2026-10-27: own AI moves to GPT-6.1 Sol, the catalog's current Sol.
        assert_eq!(default_managed_ai_model_id(), "gpt-6-luna");
        assert_eq!(default_managed_ai_model_label(), "GPT-6 Luna");
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
    fn an_agents_openai_pick_runs_the_own_ai_floor() {
        // The floor rule and its cases live in runtime-contracts; this checks
        // that an agent's model goes through it.
        for model in [
            // GPT-6 Sol, the previous own-AI default, is older than GPT-6.1 Sol.
            "gpt-6-sol",
            "gpt-5.6-sol",
            "gpt-5.5",
            " gpt-4o ",
            "o3",
            // Owner decision 2026-10-26: own AI runs at least the default, so
            // Luna, mini and nano picks below it run the default too, not a
            // cheaper tier.
            "gpt-5.6-luna",
            "gpt-5.5-mini",
            "gpt-5.4-mini",
            "o3-mini",
            "gpt-4.1-nano",
        ] {
            assert_eq!(
                resolve_agent_model_for_provider("openai", Some(model.to_string())).as_deref(),
                Some(DEFAULT_OPENAI_MODEL_ID),
                "{model:?}"
            );
        }
        // An id at the default's version, or without one, runs as picked, and
        // so does the cheaper model a person picks on purpose.
        for model in [
            DEFAULT_OPENAI_MODEL_ID.to_string(),
            OWN_AI_SMALL_MODEL_ID.to_string(),
            format!("{DEFAULT_OPENAI_MODEL_ID}-preview"),
            "gpt-image-1".to_string(),
            "openai/gpt-5.5".to_string(),
        ] {
            assert_eq!(own_ai_model_floor(&model), None, "{model}");
            assert_eq!(
                resolve_agent_model_for_provider("openai", Some(model.clone())).as_deref(),
                Some(model.as_str())
            );
        }
    }

    #[test]
    fn the_floor_applies_only_to_openai_like_providers() {
        // "assistant" agents follow the OpenAI path; other providers keep their ids.
        assert_eq!(
            floor_own_ai_model_for_provider("assistant", " gpt-5.6-sol "),
            DEFAULT_OPENAI_MODEL_ID
        );
        assert_eq!(
            floor_own_ai_model_for_provider("openai", " gpt-5.6-luna "),
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
