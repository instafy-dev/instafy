pub const DEFAULT_MANAGED_AI_PROVIDER_ID: &str = "openai";
pub const DEFAULT_OPENAI_MODEL_ID: &str = "gpt-5.6-sol";
pub const DEFAULT_OPENAI_MODEL_LABEL: &str = "GPT-5.6 Sol";
pub const DEFAULT_DEEPSEEK_MODEL_ID: &str = "deepseek-chat";
pub const DEFAULT_ZAI_MODEL_ID: &str = "glm-5";
pub const DEFAULT_GEMINI_MODEL_ID: &str = "gemini-2.5-pro";

pub fn default_managed_ai_model_id() -> &'static str {
    DEFAULT_OPENAI_MODEL_ID
}

pub fn default_managed_ai_model_label() -> &'static str {
    DEFAULT_OPENAI_MODEL_LABEL
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
        agent_model_is_compatible_with_provider, is_stale_openai_model,
        resolve_agent_model_for_provider,
    };

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
