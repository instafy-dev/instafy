//! The model a person's own AI runs by default: a bring-your-own OpenAI key, a
//! ChatGPT login and "Codex on this computer". The controller and the runtime
//! read these constants; the proxy and Studio keep one literal each, and
//! `own_ai_model_fixtures.json` fails their tests when a copy drifts.
//!
//! The managed "Instafy AI" lane is separate: its model is the controller's
//! `DEFAULT_MANAGED_AI_MODEL_ID` (or the operator's `MANAGED_AI_MODEL_ID`).

/// Default model for a person's own AI, and the model that older full-size
/// OpenAI picks are raised to.
pub const OWN_AI_DEFAULT_MODEL_ID: &str = "gpt-6-sol";

/// The small tier of the same generation: older Luna, mini and nano picks are
/// raised to it rather than to [`OWN_AI_DEFAULT_MODEL_ID`].
pub const OWN_AI_SMALL_MODEL_ID: &str = "gpt-6-luna";

/// OpenAI ids that are no longer served upstream (`gpt-4*`, `o3*`, `gpt-5`,
/// `gpt-5-codex` and `gpt-5.0` to `gpt-5.4` with any suffix). A job must not
/// send one to the proxy, or the request fails upstream with a 400 or 404.
/// Other providers' ids never match.
pub fn is_retired_openai_model(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.starts_with("gpt-4") || normalized.starts_with("o3") {
        return true;
    }
    if normalized == "gpt-5" || normalized == "gpt-5-codex" {
        return true;
    }
    normalized
        .strip_prefix("gpt-5.")
        .and_then(|rest| {
            let minor: String = rest
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect();
            minor.parse::<u32>().ok()
        })
        .is_some_and(|minor| minor < 5)
}

#[cfg(test)]
mod tests {
    use super::{is_retired_openai_model, OWN_AI_DEFAULT_MODEL_ID, OWN_AI_SMALL_MODEL_ID};
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("own_ai_model_fixtures.json")).expect("fixtures")
    }

    fn ids<'a>(fixtures: &'a Value, key: &str) -> Vec<&'a str> {
        fixtures[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixtures list {key}"))
            .iter()
            .map(|id| id.as_str().expect("model id"))
            .collect()
    }

    #[test]
    fn the_constants_are_the_fixtures_ids() {
        let fixtures = fixtures();
        assert_eq!(fixtures["defaultModelId"], OWN_AI_DEFAULT_MODEL_ID);
        assert_eq!(fixtures["smallModelId"], OWN_AI_SMALL_MODEL_ID);
        assert_ne!(OWN_AI_DEFAULT_MODEL_ID, OWN_AI_SMALL_MODEL_ID);
    }

    #[test]
    fn retired_ids_match_the_fixture() {
        let fixtures = fixtures();
        for retired in ids(&fixtures, "retired") {
            assert!(is_retired_openai_model(retired), "{retired} is retired");
        }
        for served in ids(&fixtures, "served") {
            assert!(!is_retired_openai_model(served), "{served} is served");
        }
        assert!(!is_retired_openai_model(OWN_AI_DEFAULT_MODEL_ID));
        assert!(!is_retired_openai_model(OWN_AI_SMALL_MODEL_ID));
    }
}
