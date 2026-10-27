//! The model a person's own AI runs by default: a bring-your-own OpenAI key, a
//! ChatGPT login and "Codex on this computer". The controller and the runtime
//! read these items; the proxy keeps a copy of the default and Studio a copy
//! of the default, the cheaper pick and the floor rule, and
//! `own_ai_model_fixtures.json` fails their tests when a copy drifts.
//!
//! The managed "Instafy AI" lane is separate: its model is the controller's
//! `DEFAULT_MANAGED_AI_MODEL_ID` (or the operator's `MANAGED_AI_MODEL_ID`).

/// Default model for a person's own AI, and the least that their OpenAI picks
/// run ([`own_ai_model_floor`]). Moving it moves every saved agent and
/// credential whose OpenAI id is of an older version and not of a higher tier,
/// the previous default included. `own_ai_model_fixtures.json` lists every
/// edit a move needs.
///
/// GPT-6.1 Sol is the pinned Codex catalog's current Sol ("Latest workhorse
/// model"); its GPT-6 Sol entry is the previous generation.
pub const OWN_AI_DEFAULT_MODEL_ID: &str = "gpt-6.1-sol";

/// The cheaper model a person may pick for their own AI on purpose (Studio's
/// picker offers it after the default). Instafy never picks it: defaults and
/// older picks run [`OWN_AI_DEFAULT_MODEL_ID`], and only this exact id runs as
/// picked although its version is older than the default's. Other Luna, mini
/// and nano ids are still raised.
///
/// The pinned Codex catalog does not list it for the ChatGPT plans it calls
/// `promax` and `law`, so a ChatGPT login on those plans that picks it may be
/// refused upstream; the catalog lists the default for every plan.
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

/// What a person's own OpenAI pick runs: [`OWN_AI_DEFAULT_MODEL_ID`] when the
/// pick is a bare OpenAI id of an older version than the default (`gpt-N.M…`
/// compared by `N.M`, and every `o<digit>` reasoning model), else `None`, and
/// the pick runs as it is. Luna, mini and nano ids are raised to the default
/// too: Instafy never lands a person's own AI below it on its own. The one
/// exception is [`OWN_AI_SMALL_MODEL_ID`], the cheaper model a person picks on
/// purpose.
///
/// An older id of a higher tier than the default's ([`OPENAI_TIERS`], so
/// `gpt-6-astra` under a Sol default) runs as picked: raising it would lower
/// it. An id without a listed tier (`gpt-5.5`, `gpt-5.1-codex-max`), and any id
/// under a default without one, gets no such exception.
///
/// Ids without a version (`gpt-image-1`), other providers' ids and namespaced
/// ids (`openai/gpt-5.5`) are never raised. A new default of the same version
/// (a tier change such as `gpt-6.1-sol` to `gpt-6.1-terra`) raises nothing:
/// rows saved with the old default keep running it.
///
/// Saved agents and credentials keep the id they were created with, often the
/// default of that day, so the controller applies this when it builds a job or
/// a lease. The managed lane never passes through here.
pub fn own_ai_model_floor(model: &str) -> Option<&'static str> {
    floor_for_default(OWN_AI_DEFAULT_MODEL_ID, model)
}

/// The tiers the Codex catalog names after an OpenAI id's version, cheapest
/// first. Only the floor's tier exception reads them.
const OPENAI_TIERS: &[&str] = &["luna", "terra", "sol", "astra"];

/// [`own_ai_model_floor`] for a given default, so the tests can check what a
/// later bump of the default does to ids saved before it.
fn floor_for_default<'a>(default: &'a str, model: &str) -> Option<&'a str> {
    let default_id = default.trim().to_ascii_lowercase();
    let floor = openai_version(&default_id)?;
    let model = model.trim().to_ascii_lowercase();
    if model == OWN_AI_SMALL_MODEL_ID {
        return None;
    }
    let older = match openai_version(&model) {
        Some(version) => {
            version < floor
                && !matches!(
                    (openai_tier(&model), openai_tier(&default_id)),
                    (Some(tier), Some(default_tier)) if tier > default_tier
                )
        }
        None => model
            .strip_prefix('o')
            .is_some_and(|rest| rest.starts_with(|character: char| character.is_ascii_digit())),
    };
    older.then_some(default)
}

/// `(N, M)` for a lowercase `gpt-N[.M]…` id (`gpt-6-sol` is 6.0, `gpt-5.10` is
/// 5.10), `None` for an id without a version.
fn openai_version(model: &str) -> Option<(u32, u32)> {
    openai_version_and_rest(model).map(|(version, _)| version)
}

/// The rank in [`OPENAI_TIERS`] of the word after a lowercase id's version
/// (`gpt-6-astra` and `gpt-6-astra-mini` are Astra), `None` for a word that is
/// not a tier.
fn openai_tier(model: &str) -> Option<usize> {
    let (_, rest) = openai_version_and_rest(model)?;
    let word = rest.strip_prefix('-')?.split('-').next()?;
    OPENAI_TIERS.iter().position(|tier| *tier == word)
}

fn openai_version_and_rest(model: &str) -> Option<((u32, u32), &str)> {
    let (major, rest) = leading_number(model.strip_prefix("gpt-")?)?;
    match rest.strip_prefix('.').and_then(leading_number) {
        Some((minor, rest)) => Some(((major, minor), rest)),
        None => Some(((major, 0), rest)),
    }
}

fn leading_number(text: &str) -> Option<(u32, &str)> {
    let rest = text.trim_start_matches(|character: char| character.is_ascii_digit());
    let digits = &text[..text.len() - rest.len()];
    Some((digits.parse().ok()?, rest))
}

#[cfg(test)]
mod tests {
    use super::{
        floor_for_default, is_retired_openai_model, openai_tier, openai_version,
        own_ai_model_floor, OWN_AI_DEFAULT_MODEL_ID, OWN_AI_SMALL_MODEL_ID,
    };
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

    fn cases<'a>(fixtures: &'a Value, key: &str) -> &'a Vec<Value> {
        let cases = fixtures[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixtures list {key}"));
        assert!(!cases.is_empty(), "{key}");
        cases
    }

    /// A fixture case's expected floor: `default` raises the id to the case's
    /// default, `keep` runs it as picked.
    fn expected<'a>(case: &Value, default: &'a str) -> Option<&'a str> {
        match case["runs"].as_str().expect("runs") {
            "default" => Some(default),
            "keep" => None,
            other => panic!("unknown floor target {other}"),
        }
    }

    #[test]
    fn the_default_is_the_fixtures_id_and_has_a_version() {
        assert_eq!(fixtures()["defaultModelId"], OWN_AI_DEFAULT_MODEL_ID);
        // Without a version the floor would raise nothing; without a tier it
        // would lower an older pick of a higher tier (GPT-6 Astra) to it.
        assert!(openai_version(OWN_AI_DEFAULT_MODEL_ID).is_some());
        assert!(openai_tier(OWN_AI_DEFAULT_MODEL_ID).is_some());
    }

    #[test]
    fn tiers_are_read_from_the_word_after_the_version() {
        assert_eq!(ids(&fixtures(), "tiers"), super::OPENAI_TIERS);
        assert_eq!(openai_tier("gpt-6-luna"), Some(0));
        assert_eq!(openai_tier("gpt-5.6-terra"), Some(1));
        assert_eq!(openai_tier("gpt-6.1-sol"), Some(2));
        assert_eq!(openai_tier("gpt-6-astra"), Some(3));
        assert_eq!(openai_tier("gpt-6-astra-mini"), Some(3));
        for untiered in [
            "gpt-5.5",
            "gpt-5.5-mini",
            "gpt-5.1-codex-max",
            "gpt-4o",
            "gpt-6.x-sol",
        ] {
            assert_eq!(openai_tier(untiered), None, "{untiered}");
        }
    }

    #[test]
    fn the_cheaper_pick_runs_as_picked_and_is_never_the_default() {
        assert_eq!(fixtures()["smallModelId"], OWN_AI_SMALL_MODEL_ID);
        assert_ne!(OWN_AI_SMALL_MODEL_ID, OWN_AI_DEFAULT_MODEL_ID);
        assert!(!is_retired_openai_model(OWN_AI_SMALL_MODEL_ID));
        for pick in [
            OWN_AI_SMALL_MODEL_ID.to_string(),
            format!(" {} ", OWN_AI_SMALL_MODEL_ID.to_ascii_uppercase()),
        ] {
            assert_eq!(own_ai_model_floor(&pick), None, "{pick:?}");
        }
        // Under any later default too; a variant of it is raised like any
        // older id.
        assert_eq!(floor_for_default("gpt-99-sol", OWN_AI_SMALL_MODEL_ID), None);
        let variant = format!("{OWN_AI_SMALL_MODEL_ID}-mini");
        assert_eq!(
            floor_for_default("gpt-99-sol", &variant),
            Some("gpt-99-sol")
        );
    }

    #[test]
    fn retired_ids_match_the_fixture() {
        let fixtures = fixtures();
        for retired in ids(&fixtures, "retired") {
            assert!(is_retired_openai_model(retired), "{retired} is retired");
            // Every id the runtime retires is raised by the controller first.
            assert_eq!(
                own_ai_model_floor(retired),
                Some(OWN_AI_DEFAULT_MODEL_ID),
                "{retired}"
            );
        }
        for served in ids(&fixtures, "served") {
            assert!(!is_retired_openai_model(served), "{served} is served");
        }
        assert!(!is_retired_openai_model(OWN_AI_DEFAULT_MODEL_ID));
    }

    #[test]
    fn own_ai_picks_older_than_the_default_run_the_default() {
        let fixtures = fixtures();
        for case in cases(&fixtures, "floor") {
            let model = case["model"].as_str().expect("model");
            assert_eq!(
                own_ai_model_floor(model),
                expected(case, OWN_AI_DEFAULT_MODEL_ID),
                "{model:?}"
            );
        }
        // The floor never lands below itself.
        assert_eq!(own_ai_model_floor(OWN_AI_DEFAULT_MODEL_ID), None);
    }

    #[test]
    fn a_later_default_raises_ids_saved_as_an_earlier_one() {
        // Agents and credentials saved today carry today's default; the next
        // bump of the constant must reach them without a test or row edit.
        let fixtures = fixtures();
        for case in cases(&fixtures, "floorForDefault") {
            let default = case["default"].as_str().expect("default");
            let model = case["model"].as_str().expect("model");
            assert_eq!(
                floor_for_default(default, model),
                expected(case, default),
                "{model:?} with default {default}"
            );
        }
    }
}
