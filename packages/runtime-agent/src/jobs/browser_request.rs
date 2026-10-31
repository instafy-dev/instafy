use serde_json::{Value, json};

use super::JobMessage;

#[derive(Debug, Clone)]
pub(super) struct BrowserRequest {
    task: String,
    location: &'static str,
    /// Octo is building something for the person (a page, a map, files) and
    /// continues it from what the browser finds: only such a card hands the
    /// browser's findings back to a building turn (`browser_hand_back.rs`).
    /// A card for a question leaves it out, and the browser turn's reply is
    /// the answer.
    continue_building: bool,
    /// The routing step sent the person's message straight to the browser:
    /// the card's task is their own words, and Studio folds the card into its
    /// browser turn when it opens it by itself.
    routed: bool,
}

/// Why each `request_browser` card of a reply is dropped as the reply is read
/// ([`BrowserRequest::parse`]), one reason per card. Nothing of such a card reaches the person,
/// while the reply beside it may still send them to the browser, so the runtime logs each one
/// with the turn's job.
pub(super) fn dropped_requests(reply: &Value) -> Vec<&'static str> {
    reply
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|action| {
            action
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    kind.trim().to_ascii_lowercase().replace('-', "_") == "request_browser"
                })
        })
        .filter_map(|action| BrowserRequest::parse(action).err())
        .collect()
}

impl BrowserRequest {
    /// The card a reply's `request_browser` action asks for, or why none is posted: no task, a
    /// task over 8,000 characters or an unknown browser location.
    pub(super) fn parse(value: &serde_json::Map<String, Value>) -> Result<Self, &'static str> {
        let task = value
            .get("task")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if task.is_empty() {
            return Err("no task");
        }
        if task.encode_utf16().count() > 8_000 {
            return Err("task over 8,000 characters");
        }
        let location = match value.get("browserLocation") {
            None | Some(Value::Null) => "auto",
            Some(Value::String(location)) if location == "auto" => "auto",
            Some(Value::String(location)) if location == "device" => "device",
            Some(Value::String(location)) if location == "workspace" => "workspace",
            _ => return Err("unknown browserLocation"),
        };
        let continue_building = value.get("continueBuilding") == Some(&Value::Bool(true));
        Ok(Self {
            task: task.to_owned(),
            location,
            continue_building,
            routed: false,
        })
    }

    /// The card for a message the routing step sent straight to the browser:
    /// the person's own words are its task, and the browser is chosen as for
    /// any card. None for a message no card could carry.
    pub(super) fn routed(task: &str, continue_building: bool) -> Option<Self> {
        let task = task.trim();
        if task.is_empty() || task.encode_utf16().count() > 8_000 {
            return None;
        }
        Some(Self {
            task: task.to_owned(),
            location: "auto",
            continue_building,
            routed: true,
        })
    }

    pub(super) fn message(&self) -> JobMessage {
        let mut request = json!({ "task": self.task, "location": self.location });
        if self.continue_building {
            request["continueBuilding"] = json!(true);
        }
        if self.routed {
            request["routed"] = json!(true);
        }
        JobMessage {
            content: "Continue this task in Instafy's browser.".to_owned(),
            message_type: Some("action_request".to_owned()),
            metadata: Some(json!({
                "messageType": "action_request",
                "details": {
                    "testId": "browser-request-card",
                    // No line on what pressing it does: Studio opens the
                    // browser by itself where it can, and the card then reads
                    // Opening and Opened in place of its button.
                    "title": "Continue in Instafy's browser",
                    "browserRequest": request,
                    "actions": [{
                        "id": "continue-browser",
                        "label": "Open browser and continue",
                        "variant": "primary",
                        "event": "instafy:request-browser",
                        "busyLabel": "Opening browser…",
                        "testId": "browser-request-continue"
                    }]
                }
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_request_preserves_task_and_defers_device_choice_to_studio() {
        let request = BrowserRequest::parse(
            json!({"task": "Continue comparing the items from our earlier conversation."})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        let message = request.message();
        let metadata = message.metadata.unwrap();
        assert_eq!(
            metadata["details"]["browserRequest"],
            json!({
                "task": "Continue comparing the items from our earlier conversation.", "location": "auto"
            })
        );
        assert_eq!(
            metadata["details"]["actions"][0]["event"],
            "instafy:request-browser"
        );
        assert!(
            metadata["details"]["browserRequest"]
                .get("runtimeId")
                .is_none()
        );
    }

    /// The card says what it is for, not what pressing it does: Studio opens
    /// it by itself where it can, and it reads Opening and Opened.
    #[test]
    fn browser_request_card_has_no_line_about_what_studio_does() {
        let request = BrowserRequest::parse(
            json!({"task": "Find the opening hours"})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        let details = request.message().metadata.unwrap()["details"].clone();
        assert_eq!(details["title"], "Continue in Instafy's browser");
        assert!(details.get("description").is_none(), "{details}");
        assert!(!details.to_string().contains("Studio opens"), "{details}");
    }

    #[test]
    fn only_a_card_that_continues_building_says_so() {
        let building = BrowserRequest::parse(
            json!({"task": "Read the three product pages", "continueBuilding": true})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            building.message().metadata.unwrap()["details"]["browserRequest"],
            json!({"task": "Read the three product pages", "location": "auto", "continueBuilding": true})
        );
        for value in [
            json!({"task": "Find the opening hours"}),
            json!({"task": "Find the opening hours", "continueBuilding": null}),
            json!({"task": "Find the opening hours", "continueBuilding": false}),
            json!({"task": "Find the opening hours", "continueBuilding": "true"}),
        ] {
            let request = BrowserRequest::parse(value.as_object().unwrap()).unwrap();
            assert!(
                request.message().metadata.unwrap()["details"]["browserRequest"]
                    .get("continueBuilding")
                    .is_none(),
                "{value}"
            );
        }
    }

    #[test]
    fn browser_request_accepts_explicit_location_but_rejects_incomplete_or_unknown_requests() {
        for location in ["device", "workspace", "auto"] {
            let request = BrowserRequest::parse(
                json!({"task":"Inspect the current page", "browserLocation":location})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(request.location, location);
        }
        for value in [
            json!({}),
            json!({"task":" "}),
            json!({"task":"x".repeat(8001)}),
            json!({"task":"🌍".repeat(4001)}),
            json!({"task":"Open a page", "browserLocation":42}),
            json!({"task":"Open a page", "browserLocation":"another-users-device"}),
        ] {
            assert!(BrowserRequest::parse(value.as_object().unwrap()).is_err());
        }
    }

    /// A card no one can act on posts nothing, while the reply beside it may still send the
    /// person to the browser: a reply ended "Open Instafy's browser to check…" over a card with
    /// no task, and nothing said that no card came with it. Each such card has a reason, which
    /// the runtime logs with the turn's job; a card that is posted, or another action, has none.
    #[test]
    fn a_card_dropped_for_having_no_task_says_why() {
        let reply = json!({"actions": [
            {"type": "request_browser"},
            {"type": "request_browser", "task": null, "browserLocation": null},
            {"type": " Request-Browser ", "task": " "},
            {"type": "request_browser", "task": 42},
            {"type": "request_browser", "task": "x".repeat(8001)},
            {"type": "request_browser", "task": "Open a page", "browserLocation": "another-users-device"},
            {"type": "request_browser", "task": "Find the opening hours"},
            {"type": "request_location", "precision": "approximate"},
        ]});
        assert_eq!(
            dropped_requests(&reply),
            [
                "no task",
                "no task",
                "no task",
                "no task",
                "task over 8,000 characters",
                "unknown browserLocation",
            ]
        );
        for reply in [
            json!({"summary": "Done."}),
            json!({"summary": "Done.", "actions": null}),
            json!({"actions": [{"type": "request_browser", "task": "Find the opening hours"}]}),
        ] {
            assert!(dropped_requests(&reply).is_empty(), "{reply}");
        }
    }
}
