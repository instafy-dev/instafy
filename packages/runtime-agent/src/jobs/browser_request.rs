use serde_json::{Value, json};

use super::JobMessage;

#[derive(Debug, Clone)]
pub(super) struct BrowserRequest {
    task: String,
    location: &'static str,
}

impl BrowserRequest {
    pub(super) fn parse(value: &serde_json::Map<String, Value>) -> Option<Self> {
        let task = value.get("task")?.as_str()?.trim();
        if task.is_empty() || task.encode_utf16().count() > 8_000 {
            return None;
        }
        let location = match value.get("browserLocation") {
            None | Some(Value::Null) => "auto",
            Some(Value::String(location)) if location == "auto" => "auto",
            Some(Value::String(location)) if location == "device" => "device",
            Some(Value::String(location)) if location == "workspace" => "workspace",
            _ => return None,
        };
        Some(Self {
            task: task.to_owned(),
            location,
        })
    }

    /// The handoff card. `workspace_browser` is whether this runtime runs a
    /// Workspace browser; when it does not, the card says so
    /// (`workspaceBrowser: false`) and Studio opens the browser on the
    /// person's device or explains that none can open, instead of offering a
    /// press that waits for a browser this workspace does not have.
    pub(super) fn message(&self, workspace_browser: bool) -> JobMessage {
        let mut browser_request = json!({ "task": self.task, "location": self.location });
        if !workspace_browser {
            browser_request["workspaceBrowser"] = json!(false);
        }
        JobMessage {
            content: "Continue this task in your browser.".to_owned(),
            message_type: Some("action_request".to_owned()),
            metadata: Some(json!({
                "messageType": "action_request",
                "details": {
                    "testId": "browser-request-card",
                    "title": "Continue in browser",
                    "description": "Open your browser and let the AI continue this task there.",
                    "browserRequest": browser_request,
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
        let message = request.message(true);
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

    #[test]
    fn browser_request_says_when_this_runtime_has_no_workspace_browser() {
        let request = BrowserRequest::parse(
            json!({"task": "Open https://app.example.test and take me to Settings."})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        let without = request.message(false).metadata.unwrap();
        assert_eq!(
            without["details"]["browserRequest"],
            json!({
                "task": "Open https://app.example.test and take me to Settings.",
                "location": "auto",
                "workspaceBrowser": false
            })
        );
        let with = request.message(true).metadata.unwrap();
        assert!(
            with["details"]["browserRequest"]
                .get("workspaceBrowser")
                .is_none()
        );
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
}
