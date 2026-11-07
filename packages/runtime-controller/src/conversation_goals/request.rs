//! A continuation keeps the source's execution constraints, not its one-turn
//! approvals, routing decisions or controller-issued capabilities.

use serde_json::{json, Value};

pub(super) fn continuation_metadata(source: &Value) -> Value {
    let mut metadata = json!({});
    for key in [
        "execution_mode",
        "executionMode",
        "workspaceMode",
        "workspace_mode",
        "writeIntent",
        "write_intent",
        "writeScope",
        "write_scope",
        "runtimePreference",
        "runtimeRouting",
        "runtime_routing",
        "assistantCapabilityContext",
    ] {
        if let Some(value) = source.get(key) {
            // Dispatch records unscoped work explicitly, but its input parser
            // accepts only concrete scopes. Absence recreates the same unscoped
            // assignment; forwarding its output shape would instead be refused
            // as an invalid explicit scope.
            if key == "writeScope" && value.get("mode").and_then(Value::as_str) == Some("unscoped")
            {
                continue;
            }
            metadata[key] = value.clone();
        }
    }
    // Dispatch stamps the actual selected agent into each job. Re-select that
    // profile, not the original fanout or prompt segments. Its current model,
    // reasoning effort, credential and secret grants are resolved normally by
    // dispatch/secrets; metadata.model/reasoningEffort are not model overrides.
    if let Some(handle) = source.pointer("/agent/handle").and_then(Value::as_str) {
        metadata["agentSelection"] = json!({"active": [handle], "mentions": [handle]});
    }
    // agent_write_scopes stamps canonical writeScope on every scoped source
    // job. Keeping it above lets ordinary dispatch reapply the same constraints
    // to this single selected agent. Top-level payload.tool_limits is carried
    // separately by the request builder, not hidden in prompt metadata.
    metadata
}

/// Browser control is admitted against a visible target, runtime and current
/// consent. Until goals can renew that contract, stop visibly rather than
/// silently changing a browser-only job into an ordinary workspace job.
pub(super) fn source_requires_explicit_resume(source: &Value) -> bool {
    [
        "browserTransport",
        "browser_transport",
        "browserRuntimeId",
        "browser_runtime_id",
        "browserPageId",
        "browser_page_id",
    ]
    .iter()
    .any(|key| source.get(*key).is_some_and(|value| !value.is_null()))
        || ["runtimeExpectations", "runtime_expectations"]
            .iter()
            .filter_map(|key| source.get(*key))
            .any(|expectations| {
                ["browserExecution", "browser_execution"].iter().any(|key| {
                    expectations
                        .get(*key)
                        .is_some_and(|value| !value.is_null() && value != &Value::Bool(false))
                })
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn redispatch_keeps_the_selected_profiles_owned_or_read_only_scope() {
        for scope in [
            json!({"mode":"owned", "ownedPaths":["src/widget.rs"], "readOnlyPaths":["tests"]}),
            json!({"mode":"read_only", "ownedPaths":[], "readOnlyPaths":["src"]}),
        ] {
            let source = json!({
                "agent":{"handle":"reviewer", "id":"profile-id"},
                "agentSelection":{"active":["reviewer","other"], "mentions":["other"],
                    "promptSegments":{"reviewer":"Old assignment"}},
                "execution_mode":"apply", "workspaceMode":"shared_read",
                "writeIntent":true, "writeScope":scope,
                "runtimeExpectations":{"commandExecution":true,"workspaceFileChanges":true},
                "runtime_expectations":{"command_execution":true,"workspace_file_changes":true},
                "runtimeRouting":{"strategy":"exact","allowUntargetedAcrossPreferredRuntimes":false},
                "_controllerGoal":{"revision":"old"},
                "goal":{"id":"old-goal"}, "goalContinuation":{"turn":7},
                "automaticRetry":{"sourceJobId":"old-job"},
                "controllerDispatch":{"suppressUserMessage":true},
                "approvedCommands":["old command"], "browserApprovedSites":["example.test"],
                "browserHandBack":{"browserJobId":"old-browser-job"},
                "agentRoutingPreflight":{"route":"team"}
            });
            let metadata = continuation_metadata(&source);
            assert_eq!(
                metadata,
                json!({
                    "agentSelection":{"active":["reviewer"],"mentions":["reviewer"]},
                    "execution_mode":"apply", "workspaceMode":"shared_read",
                    "writeIntent":true, "writeScope":scope,
                    "runtimeRouting":{"strategy":"exact","allowUntargetedAcrossPreferredRuntimes":false},
                })
            );
            // These were obligations of the completed turn, not permission
            // restrictions. The next routing step derives its own evidence needs.
            assert!(metadata.get("runtimeExpectations").is_none());
            assert!(metadata.get("runtime_expectations").is_none());
            let plan = crate::agent_write_scopes::build_agent_write_scope_plan(
                &metadata,
                "Continue the goal",
                &["reviewer".into()],
                &HashMap::new(),
            );
            let reapplied = plan["reviewer"].to_json();
            for key in ["mode", "ownedPaths", "readOnlyPaths"] {
                assert_eq!(reapplied[key], scope[key], "lost {key} on redispatch");
            }
        }
    }

    #[test]
    fn ordinary_unscoped_writes_do_not_become_invalid_explicit_scopes() {
        let source = json!({"agent":{"handle":"octo"},"writeIntent":true,
            "writeScope":{"mode":"unscoped","ownedPaths":[],"readOnlyPaths":[]}});
        let metadata = continuation_metadata(&source);
        let plan = crate::agent_write_scopes::build_agent_write_scope_plan(
            &metadata,
            "Continue",
            &["octo".into()],
            &HashMap::new(),
        );
        assert_eq!(plan["octo"].to_json()["mode"], "unscoped");
    }

    #[test]
    fn legacy_scope_alias_survives_ordinary_dispatch_validation() {
        let source = json!({"agent":{"handle":"reviewer"},"write_scope":{"mode":"read_only"}});
        let metadata = continuation_metadata(&source);
        let plan = crate::agent_write_scopes::build_agent_write_scope_plan(
            &metadata,
            "Continue",
            &["reviewer".into()],
            &HashMap::new(),
        );
        assert_eq!(plan["reviewer"].to_json()["mode"], "read_only");
    }

    #[test]
    fn browser_control_requires_fresh_authorization_instead_of_losing_its_tools() {
        for source in [
            json!({"browserTransport":"shared","browserPageId":"page-1","browserConsentVersion":1}),
            json!({"browser_transport":"desktop_personal","browser_runtime_id":"runtime"}),
            json!({"browserPageId":"page-1"}),
            json!({"runtimeExpectations":{"browserExecution":true}}),
            json!({"runtime_expectations":{"browser_execution":"required"}}),
        ] {
            assert!(source_requires_explicit_resume(&source), "{source}");
            let metadata = continuation_metadata(&source);
            assert!(metadata.get("browserTransport").is_none());
            assert!(metadata.get("browserConsentVersion").is_none());
        }
        assert!(!source_requires_explicit_resume(&json!({
            "runtimeExpectations":{"browserExecution":false,"commandExecution":true},
            "browserHandBack":{"browserJobId":"completed-job"}
        })));
    }
}
