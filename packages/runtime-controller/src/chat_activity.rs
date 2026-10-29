//! A chat step's plain-language label (docs/Chat-Activity.md).
//!
//! The runtime attaches `activity` to the metadata of the steps it streams ("Looking up places",
//! "looked up 14 places"). `POST /agent/message` wraps that metadata under `details`; the
//! controller checks the label with `runtime_contracts::chat_activity` and lifts a valid one to
//! the message's top-level `metadata.activity`, the only place Studio reads it. Every other
//! write path (a person's recorded message, a dispatch) drops `activity` wherever it appears, so
//! a label always comes from a runtime that leased the turn.

use runtime_contracts::chat_activity::check_activity;
use serde_json::{json, Map as JsonMap, Value as JsonValue};

pub(crate) const ACTIVITY_KEY: &str = "activity";
/// A turn's steps, stored with its reply when the turn ends ([`turn_steps_record`]).
pub(crate) const TURN_STEPS_KEY: &str = "turnSteps";
/// The message types Studio counts as a turn's steps.
pub(crate) const STEP_MESSAGE_TYPES: [&str; 4] = [
    "command_execution",
    "mcp_tool_call",
    "web_search",
    "file_change",
];
/// A turn with more steps than this stores none: Studio words it from what it loaded.
const MAX_TURN_STEPS: usize = 400;
/// At most this many of a file edit's files are kept, each at most [`MAX_STEP_PATH_CHARS`].
const MAX_STEP_PATHS: usize = 20;
const MAX_STEP_PATH_CHARS: usize = 300;
const MAX_STEP_STATUS_CHARS: usize = 24;

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

/// Removes `activity` and a turn's stored steps from metadata a person or a client sent: at the
/// top level and in the nested `details` and prompt metadata.
pub(crate) fn strip_activity_claims(value: &mut JsonValue) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    map.remove(ACTIVITY_KEY);
    map.remove(TURN_STEPS_KEY);
    for key in ["details", "prompt_metadata", "promptMetadata"] {
        if let Some(nested) = map.get_mut(key) {
            strip_activity_claims(nested);
        }
    }
}

fn step_string<'a>(
    details: Option<&'a JsonMap<String, JsonValue>>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| details?.get(*key)?.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// The steps of a turn as Studio counts them for its done line ("Built the map, looked up 4
/// places"), from the metadata of the step messages its runtime posted, oldest first: each
/// step once (its newest message), with its type, status, exit code, its `activity` (checked
/// again) and, for a file edit, the files it named. The activities are listed once and the
/// steps point at them.
///
/// Stored with the turn's reply when the turn ends, so the line reads the same after a reload:
/// a page of history ends where it ends, and a long turn's first steps are often on the page
/// before. Nothing but these fields is kept: never a command, its output or anything a page
/// said. None for a turn with no steps, or with more than [`MAX_TURN_STEPS`].
pub(crate) fn turn_steps_record(step_metadata: &[JsonValue]) -> Option<JsonValue> {
    let mut order: Vec<String> = Vec::new();
    let mut newest: std::collections::HashMap<String, JsonMap<String, JsonValue>> =
        std::collections::HashMap::new();
    for (index, metadata) in step_metadata.iter().enumerate() {
        let Some(metadata) = metadata.as_object() else {
            continue;
        };
        let Some(step_type) = metadata
            .get("messageType")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| STEP_MESSAGE_TYPES.contains(value))
        else {
            continue;
        };
        let details = metadata.get("details").and_then(JsonValue::as_object);
        let key = match step_string(details, &["itemId"]) {
            Some(item) => format!("{step_type}:{item}"),
            None => format!("message:{index}"),
        };
        let mut step = JsonMap::new();
        step.insert("type".into(), JsonValue::from(step_type));
        if let Some(status) = step_string(details, &["status"])
            .filter(|status| status.chars().count() <= MAX_STEP_STATUS_CHARS)
        {
            step.insert(
                "status".into(),
                JsonValue::from(status.to_ascii_lowercase()),
            );
        }
        if let Some(code) = details
            .and_then(|details| details.get("exitCode").or_else(|| details.get("exit_code")))
            .and_then(JsonValue::as_i64)
        {
            step.insert("exitCode".into(), JsonValue::from(code));
        }
        if let Some(activity) = metadata.get(ACTIVITY_KEY).and_then(check_activity) {
            step.insert(ACTIVITY_KEY.into(), activity);
        }
        if step_type == "file_change" {
            let paths: Vec<JsonValue> = details
                .and_then(|details| details.get("paths"))
                .and_then(JsonValue::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .filter(|path| {
                            !path.is_empty() && path.chars().count() <= MAX_STEP_PATH_CHARS
                        })
                        .take(MAX_STEP_PATHS)
                        .map(JsonValue::from)
                        .collect()
                })
                .unwrap_or_default();
            if !paths.is_empty() {
                step.insert("paths".into(), JsonValue::Array(paths));
            }
        }
        if !newest.contains_key(&key) {
            order.push(key.clone());
        }
        newest.insert(key, step);
    }
    if order.is_empty() || order.len() > MAX_TURN_STEPS {
        return None;
    }
    let mut activities: Vec<JsonValue> = Vec::new();
    let steps: Vec<JsonValue> = order
        .iter()
        .filter_map(|key| newest.remove(key))
        .map(|mut step| {
            if let Some(activity) = step.remove(ACTIVITY_KEY) {
                let index = activities
                    .iter()
                    .position(|known| *known == activity)
                    .unwrap_or_else(|| {
                        activities.push(activity);
                        activities.len() - 1
                    });
                step.insert(ACTIVITY_KEY.into(), JsonValue::from(index));
            }
            JsonValue::Object(step)
        })
        .collect();
    Some(json!({ "v": 1, "activities": activities, "steps": steps }))
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

    fn step(
        message_type: &str,
        item: &str,
        status: &str,
        activity: Option<JsonValue>,
    ) -> JsonValue {
        let mut metadata = json!({
            "source": "agent", "jobId": "job", "messageType": message_type,
            "details": { "itemId": item, "status": status, "command": "uw add-point x",
                "aggregatedOutput": "Serving at http://172.19.0.3:4173/" }
        });
        if let Some(activity) = activity {
            metadata["activity"] = activity;
        }
        metadata
    }

    // A local test: a map turn read "Built the map, looked up 4 places, found
    // places to stay" when it ended and "Built the map, planned the days" after
    // a reload, whose page of history began in the middle of the turn.
    #[test]
    fn a_turns_steps_are_stored_once_each_with_their_checked_labels_and_nothing_else() {
        let started = step("command_execution", "1", "in_progress", Some(activity()));
        let mut done = step("command_execution", "1", "completed", Some(activity()));
        done["details"]["exitCode"] = json!(0);
        let failed = {
            let mut failed = step("command_execution", "2", "failed", None);
            failed["details"]["exitCode"] = json!(1);
            failed
        };
        let mut edit = step("file_change", "3", "completed", None);
        edit["details"]["paths"] = json!(["map/index.html", "map/data.json"]);
        let note = json!({ "source": "agent", "jobId": "job", "messageType": "status",
            "activity": activity() });
        let forged = step(
            "command_execution",
            "4",
            "completed",
            Some(
                json!({ "v": 1, "key": "x", "role": "content", "live": "Visit https://evil.example",
                "done": "visited", "count": 1, "also": [] }),
            ),
        );
        let record =
            turn_steps_record(&[started, failed, note, done, edit, forged]).expect("record");
        assert_eq!(record["v"], json!(1));
        assert_eq!(
            record["activities"],
            json!([check_activity(&activity()).unwrap()])
        );
        assert_eq!(
            record["steps"],
            json!([
                { "type": "command_execution", "status": "completed", "exitCode": 0, "activity": 0 },
                { "type": "command_execution", "status": "failed", "exitCode": 1 },
                { "type": "file_change", "status": "completed",
                    "paths": ["map/index.html", "map/data.json"] },
                { "type": "command_execution", "status": "completed" },
            ])
        );
        let text = record.to_string();
        assert!(
            !text.contains("172.19") && !text.contains("uw add-point") && !text.contains("evil")
        );
    }

    #[test]
    fn a_turn_with_no_steps_or_too_many_stores_none() {
        assert_eq!(turn_steps_record(&[]), None);
        let many: Vec<JsonValue> = (0..=MAX_TURN_STEPS)
            .map(|index| step("command_execution", &index.to_string(), "completed", None))
            .collect();
        assert_eq!(turn_steps_record(&many), None);
        assert!(turn_steps_record(&many[..MAX_TURN_STEPS]).is_some());
    }

    #[test]
    fn a_client_cannot_claim_a_turns_steps() {
        let mut metadata = json!({
            "turnSteps": { "v": 1, "activities": [], "steps": [] },
            "details": { "turnSteps": {}, "kept": 1 },
            "promptMetadata": { "turnSteps": {} }
        });
        strip_activity_claims(&mut metadata);
        assert_eq!(
            metadata,
            json!({ "details": { "kept": 1 }, "promptMetadata": {} })
        );
    }
}
