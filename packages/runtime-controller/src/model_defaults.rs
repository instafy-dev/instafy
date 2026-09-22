pub const DEFAULT_MANAGED_AI_PROVIDER_ID: &str = "openai";

/// Default model for bring-your-own OpenAI credentials: API keys without a
/// provider hint and ChatGPT logins (`codex_auth_json`). Those users pay by
/// subscription or their own key, so the stronger Sol tier is the right default.
/// This is also the floor that stale ids are raised to (`is_stale_openai_model`).
pub const DEFAULT_OPENAI_MODEL_ID: &str = "gpt-5.6-sol";

/// Default model for the operator-paid managed "Instafy AI" tier (credits).
/// GPT-6 Luna is priced at $0.10 / $0.01 cached / $0.50 per 1M tokens (public
/// price pages, 2026-09-22), versus GPT-6 Sol at $2 / $0.20 / $10. Managed
/// turns are charged to the shared team balance, so the cheaper model is the
/// default; operators override it with `MANAGED_AI_MODEL_ID`.
pub const DEFAULT_MANAGED_AI_MODEL_ID: &str = "gpt-6-luna";
pub const DEFAULT_MANAGED_AI_MODEL_LABEL: &str = "GPT-6 Luna";

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

/// OpenAI models below gpt-5.5 are no longer served upstream; stale ids
/// persisted on agents/settings must not reach the proxy or requests fail
/// with 400/404 at the backend.
pub fn is_stale_openai_model(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.starts_with("gpt-4") || normalized.starts_with("o3") {
        return true;
    }
    if normalized == "gpt-5" || normalized == "gpt-5-codex" {
        return true;
    }
    if let Some(rest) = normalized.strip_prefix("gpt-5.") {
        let minor: String = rest
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        if let Ok(value) = minor.parse::<u32>() {
            return value < 5;
        }
    }
    false
}

pub fn resolve_agent_model_for_provider(
    provider: &str,
    configured_model: Option<String>,
) -> Option<String> {
    // Providers without an agent default resolve through the OpenAI path.
    let openai_like = default_agent_model_for_provider(provider).is_none();

    if let Some(model) = configured_model {
        let normalized = model.trim().to_string();
        if agent_model_is_compatible_with_provider(provider, &normalized) {
            if openai_like && is_stale_openai_model(&normalized) {
                return Some(DEFAULT_OPENAI_MODEL_ID.to_string());
            }
            return Some(normalized);
        }
    }

    default_agent_model_for_provider(provider).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        agent_model_is_compatible_with_provider, default_chatgpt_model_id,
        default_managed_ai_model_id, default_managed_ai_model_label, default_model_for_provider,
        is_stale_openai_model, resolve_agent_model_for_provider,
        DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K,
        DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K, DEFAULT_MANAGED_AI_MODEL_ID,
        DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K,
    };

    #[test]
    fn managed_tier_defaults_to_luna_while_byo_credentials_keep_sol() {
        // Owner decision 2026-09-17: only the operator-paid managed tier moves
        // to Luna. ChatGPT logins, API keys, and the stale-model floor stay on Sol.
        // 2026-09-22: the managed tier follows Luna to GPT-6 Luna on its release.
        assert_eq!(default_managed_ai_model_id(), "gpt-6-luna");
        assert_eq!(default_managed_ai_model_label(), "GPT-6 Luna");
        assert_eq!(default_chatgpt_model_id(), "gpt-5.6-sol");
        assert_eq!(default_model_for_provider("openai"), "gpt-5.6-sol");
        assert_eq!(default_model_for_provider(""), "gpt-5.6-sol");
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
    fn stale_openai_models_are_floored_to_current_default() {
        for stale in [
            "gpt-5.1-codex-mini",
            "gpt-5.1-codex-max",
            "gpt-5.2-codex",
            "gpt-5.3-codex",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.2",
            "gpt-5-codex",
            "gpt-4.5",
            "o3-mini",
        ] {
            assert!(is_stale_openai_model(stale), "{stale} should be stale");
            assert_eq!(
                resolve_agent_model_for_provider("openai", Some(stale.to_string())).as_deref(),
                Some("gpt-5.6-sol"),
                "{stale} should resolve to the default model"
            );
        }

        assert!(!is_stale_openai_model("gpt-5.5"));
        assert!(!is_stale_openai_model("gpt-5.10"));
        assert_eq!(
            resolve_agent_model_for_provider("openai", Some("gpt-5.4-mini".to_string())).as_deref(),
            Some("gpt-5.6-sol")
        );

        // The managed tier default must survive the stale floor untouched: if the
        // rule ever tightened to "anything but Sol", every managed turn would be
        // silently floored back to Sol.
        assert!(!is_stale_openai_model(DEFAULT_MANAGED_AI_MODEL_ID));
        assert_eq!(
            resolve_agent_model_for_provider(
                "openai",
                Some(DEFAULT_MANAGED_AI_MODEL_ID.to_string())
            )
            .as_deref(),
            Some("gpt-6-luna")
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
