//! A chat step's plain-language label (docs/Chat-Activity.md).
//!
//! The runtime attaches `activity` to the metadata of the steps it streams ("Looking up places",
//! "looked up 14 places"). `POST /agent/message` wraps that metadata under `details`; the
//! controller checks the label with `runtime_contracts::chat_activity` and lifts a valid one to
//! the message's top-level `metadata.activity`, the only place Studio reads it. Every other
//! write path (a person's recorded message, a dispatch) drops `activity` wherever it appears, so
//! a label always comes from a runtime that leased the turn.

use runtime_contracts::chat_activity::check_activity;
use serde_json::{Map as JsonMap, Value as JsonValue};

pub(crate) const ACTIVITY_KEY: &str = "activity";

/// Moves the runtime's `details.activity` to the top-level `activity` when it passes the label
/// rules, and drops it from `details` either way.
pub(crate) fn lift_agent_activity(metadata: &mut JsonMap<String, JsonValue>) {
    let claimed = metadata
        .get_mut("details")
        .and_then(JsonValue::as_object_mut)
        .and_then(|details| details.remove(ACTIVITY_KEY));
    metadata.remove(ACTIVITY_KEY);
    if let Some(activity) = claimed.as_ref().and_then(check_activity) {
        metadata.insert(ACTIVITY_KEY.to_string(), activity);
    }
}

/// Removes `activity` from metadata a person or a client sent: at the top level and in the
/// nested `details` and prompt metadata.
pub(crate) fn strip_activity_claims(value: &mut JsonValue) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    map.remove(ACTIVITY_KEY);
    for key in ["details", "prompt_metadata", "promptMetadata"] {
        if let Some(nested) = map.get_mut(key) {
            strip_activity_claims(nested);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn activity() -> JsonValue {
        json!({
            "v": 1, "key": "instafy/web-read", "role": "content", "live": "Reading pages",
            "done": { "one": "read a page", "other": "read {n} pages", "some": "read pages" },
            "count": 6, "also": []
        })
    }

    #[test]
    fn a_dispatched_message_cannot_carry_activity() {
        let mut metadata = json!({
            "activity": activity(),
            "details": { "activity": activity(), "kept": 1 },
            "prompt_metadata": { "activity": activity() },
            "promptMetadata": { "details": { "activity": activity() } },
            "custom": "kept"
        });
        strip_activity_claims(&mut metadata);
        assert_eq!(
            metadata,
            json!({
                "details": { "kept": 1 },
                "prompt_metadata": {},
                "promptMetadata": { "details": {} },
                "custom": "kept"
            })
        );
    }

    #[test]
    fn a_recorded_message_cannot_carry_activity() {
        for trusted in [false, true] {
            let sanitized = crate::conversations::sanitize_client_recorded_message_metadata(
                json!({ "source": "agent", "jobId": "x", "activity": activity(),
                    "details": { "activity": activity() } }),
                trusted,
            );
            assert!(sanitized.get("activity").is_none(), "{sanitized}");
            assert!(
                sanitized["details"].get("activity").is_none(),
                "{sanitized}"
            );
        }
    }

    #[test]
    fn a_top_level_claim_never_survives_the_lift() {
        let mut metadata = json!({ "activity": activity(), "details": { "kind": "x" } });
        lift_agent_activity(metadata.as_object_mut().unwrap());
        assert!(metadata.get("activity").is_none());
    }
}
