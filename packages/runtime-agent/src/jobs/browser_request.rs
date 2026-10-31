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

/// A card a reply asked for that is not posted. Nothing of it reaches the person, while the
/// reply beside it may still send them to the browser, so the log says why it was dropped.
fn dropped(reason: &str) -> Option<BrowserRequest> {
    tracing::warn!(%reason, "dropped request_browser action");
    None
}

impl BrowserRequest {
    pub(super) fn parse(value: &serde_json::Map<String, Value>) -> Option<Self> {
        let task = value
            .get("task")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if task.is_empty() {
            return dropped("no task");
        }
        if task.encode_utf16().count() > 8_000 {
            return dropped("task over 8,000 characters");
        }
        let location = match value.get("browserLocation") {
            None | Some(Value::Null) => "auto",
            Some(Value::String(location)) if location == "auto" => "auto",
            Some(Value::String(location)) if location == "device" => "device",
            Some(Value::String(location)) if location == "workspace" => "workspace",
            _ => return dropped("unknown browserLocation"),
        };
        let continue_building = value.get("continueBuilding") == Some(&Value::Bool(true));
        Some(Self {
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
            assert!(BrowserRequest::parse(value.as_object().unwrap()).is_none());
        }
    }

    #[derive(Clone, Default)]
    struct CapturedLog(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for CapturedLog {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CapturedLog {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn warnings_while(run: impl FnOnce()) -> String {
        let log = CapturedLog::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(log.clone())
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, run);
        String::from_utf8_lossy(&log.0.lock().unwrap()).to_string()
    }

    /// A card no one can act on posts nothing, and the reply beside it may still send the person
    /// to the browser: a reply ended "Open Instafy's browser to check…" over a card with no task,
    /// and nothing said that no card came with it. The log now says so, and why.
    #[test]
    fn a_card_dropped_for_having_no_task_leaves_a_log_line() {
        let log = warnings_while(|| {
            for value in [
                json!({"type": "request_browser"}),
                json!({"type": "request_browser", "task": null, "browserLocation": null}),
                json!({"type": "request_browser", "task": " "}),
            ] {
                assert!(BrowserRequest::parse(value.as_object().unwrap()).is_none());
            }
        });
        assert_eq!(
            log.matches("dropped request_browser action").count(),
            3,
            "{log}"
        );
        assert_eq!(log.matches("reason=no task").count(), 3, "{log}");

        let log = warnings_while(|| {
            for value in [
                json!({"task": "x".repeat(8001)}),
                json!({"task": "Open a page", "browserLocation": "another-users-device"}),
            ] {
                assert!(BrowserRequest::parse(value.as_object().unwrap()).is_none());
            }
        });
        assert!(log.contains("reason=task over 8,000 characters"), "{log}");
        assert!(log.contains("reason=unknown browserLocation"), "{log}");

        // A card that is posted logs nothing.
        let log = warnings_while(|| {
            BrowserRequest::parse(
                json!({"task": "Find the opening hours"})
                    .as_object()
                    .unwrap(),
            )
            .expect("a card");
        });
        assert!(log.is_empty(), "{log}");
    }
}
