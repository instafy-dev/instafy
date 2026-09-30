//! The "execute before answering" contract of a runtime turn (`require_first_tool_call`).
//!
//! The Instafy fork of Codex used to turn the turn's `codex.required_tool=command_once` metadata
//! into `tool_choice: "required"` until the model's first execution tool call. Upstream Codex
//! (rust-v0.159) always sends `tool_choice: "auto"` and offers no hook to change it, so the
//! runtime arms this gate for the turn's thread instead. While it is armed, every generation
//! request of that thread carries `client_metadata["instafy.require_tool_call"] = "1"`; the
//! Instafy proxy turns that into `tool_choice: "required"` when the request offers top-level
//! tools. The first execution tool the thread starts disarms it (a top-level code-mode `exec`
//! counts, `wait` does not), and so does the end of the turn.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use codex_extension_api::{
    McpToolContext, ModelRequestContributor, ModelRequestInput, ModelRequestKind,
    ModelResponseInterceptor, ToolCallSource, ToolLifecycleContributor, ToolLifecycleFuture,
    ToolName, ToolStartInput, TurnAbortInput, TurnLifecycleContributor, TurnStopInput,
};

/// The request metadata key the Instafy proxy reads.
pub(crate) const REQUIRE_TOOL_CALL_METADATA_KEY: &str = "instafy.require_tool_call";

/// Browser MCP tools that act on or read the page. `status` and `request_human_input` do not.
const BROWSER_EXECUTION_TOOL_NAMES: [&str; 6] =
    ["snapshot", "navigate", "click", "type", "press", "scroll"];
const BROWSER_MCP_SERVER_NAMES: [&str; 2] = ["instafy_personal_browser", "instafy_shared_browser"];

/// Built-in tools that execute something in the workspace.
const BUILTIN_EXECUTION_TOOL_NAMES: [&str; 6] = [
    "exec_command",
    "write_stdin",
    "shell",
    "shell_command",
    "local_shell",
    "apply_patch",
];

/// Threads whose turn must execute a tool before the model may answer.
#[derive(Clone, Debug, Default)]
pub(crate) struct RequiredExecutionGate {
    armed: Arc<Mutex<HashSet<String>>>,
}

impl RequiredExecutionGate {
    pub(crate) fn arm(&self, thread_id: &str) {
        self.armed_threads().insert(thread_id.to_string());
    }

    fn disarm(&self, thread_id: &str) {
        self.armed_threads().remove(thread_id);
    }

    pub(crate) fn is_armed(&self, thread_id: &str) -> bool {
        self.armed_threads().contains(thread_id)
    }

    fn armed_threads(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        // The set holds no invariant a panicking holder could break.
        self.armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl ModelRequestContributor for RequiredExecutionGate {
    fn request(&self, input: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        if input.kind == ModelRequestKind::Generation && self.is_armed(input.thread_id) {
            input
                .client_metadata
                .get_or_insert_default()
                .insert(REQUIRE_TOOL_CALL_METADATA_KEY.to_string(), "1".to_string());
        }
        None
    }
}

impl ToolLifecycleContributor for RequiredExecutionGate {
    fn on_tool_start<'a>(&'a self, input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a> {
        if tool_counts_as_execution(input.tool_name, input.mcp_tool, &input.source) {
            self.disarm(input.thread_store.level_id());
        }
        Box::pin(std::future::ready(()))
    }
}

impl TurnLifecycleContributor for RequiredExecutionGate {
    fn on_turn_stop<'a>(
        &'a self,
        input: TurnStopInput<'a>,
    ) -> codex_extension_api::ExtensionFuture<'a, ()> {
        self.disarm(input.thread_store.level_id());
        Box::pin(std::future::ready(()))
    }

    fn on_turn_abort<'a>(
        &'a self,
        input: TurnAbortInput<'a>,
    ) -> codex_extension_api::ExtensionFuture<'a, ()> {
        self.disarm(input.thread_store.level_id());
        Box::pin(std::future::ready(()))
    }
}

fn tool_counts_as_execution(
    tool_name: &ToolName,
    mcp_tool: Option<&McpToolContext>,
    source: &ToolCallSource,
) -> bool {
    if let Some(mcp_tool) = mcp_tool {
        let info = mcp_tool.tool_info();
        return mcp_tool_counts_as_execution(&info.server_name, info.tool.name.as_ref());
    }
    if tool_name.is_default_namespace() {
        return builtin_tool_counts_as_execution(&tool_name.name, source);
    }
    // An MCP call whose context could not be captured: classify it by its `mcp__<server>__`
    // namespace.
    tool_name
        .namespace
        .as_deref()
        .and_then(|namespace| namespace.strip_prefix("mcp__"))
        .map(|server| server.trim_end_matches("__"))
        .is_some_and(|server| mcp_tool_counts_as_execution(server, &tool_name.name))
}

fn builtin_tool_counts_as_execution(name: &str, source: &ToolCallSource) -> bool {
    if name == codex_code_mode::PUBLIC_TOOL_NAME {
        // Code-mode-only models run every tool inside a top-level `exec` cell.
        return matches!(source, ToolCallSource::Direct);
    }
    BUILTIN_EXECUTION_TOOL_NAMES.contains(&name)
}

fn mcp_tool_counts_as_execution(server: &str, tool: &str) -> bool {
    if BROWSER_MCP_SERVER_NAMES.contains(&server) {
        return BROWSER_EXECUTION_TOOL_NAMES.contains(&tool);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn request(gate: &RequiredExecutionGate, kind: ModelRequestKind, thread_id: &str) -> bool {
        let mut metadata: Option<HashMap<String, String>> = None;
        let interceptor = gate.request(ModelRequestInput {
            kind,
            thread_id,
            client_metadata: &mut metadata,
            model: "gpt-5.5",
        });
        assert!(interceptor.is_none());
        match metadata {
            None => false,
            Some(metadata) => {
                assert_eq!(
                    metadata,
                    HashMap::from([(REQUIRE_TOOL_CALL_METADATA_KEY.to_string(), "1".to_string())])
                );
                true
            }
        }
    }

    fn code_mode_source() -> ToolCallSource {
        ToolCallSource::CodeMode {
            cell_id: "cell".to_string(),
            runtime_tool_call_id: "call".to_string(),
        }
    }

    #[test]
    fn only_generation_requests_of_an_armed_thread_are_marked() {
        let gate = RequiredExecutionGate::default();
        assert!(!request(&gate, ModelRequestKind::Generation, "thread-a"));
        gate.arm("thread-a");
        assert!(request(&gate, ModelRequestKind::Generation, "thread-a"));
        assert!(!request(&gate, ModelRequestKind::Warmup, "thread-a"));
        // A child agent's thread is not bound by its parent's contract.
        assert!(!request(&gate, ModelRequestKind::Generation, "thread-b"));
        gate.disarm("thread-a");
        assert!(!request(&gate, ModelRequestKind::Generation, "thread-a"));
    }

    #[test]
    fn a_top_level_code_mode_exec_counts_but_wait_does_not() {
        let exec = ToolName::plain(codex_code_mode::PUBLIC_TOOL_NAME);
        assert!(tool_counts_as_execution(
            &exec,
            None,
            &ToolCallSource::Direct
        ));
        assert!(tool_counts_as_execution(
            &exec.clone().with_default_namespace(),
            None,
            &ToolCallSource::Direct
        ));
        assert!(!tool_counts_as_execution(
            &ToolName::plain(codex_code_mode::WAIT_TOOL_NAME),
            None,
            &ToolCallSource::Direct
        ));
    }

    #[test]
    fn workspace_execution_tools_count_from_any_source() {
        for name in BUILTIN_EXECUTION_TOOL_NAMES {
            for source in [ToolCallSource::Direct, code_mode_source()] {
                assert!(
                    tool_counts_as_execution(&ToolName::plain(name), None, &source),
                    "{name}"
                );
            }
        }
        for helper in [
            "update_plan",
            "list_mcp_resources",
            "tool_search",
            "view_image",
            "request_user_input",
            "spawn_agent",
        ] {
            assert!(
                !tool_counts_as_execution(&ToolName::plain(helper), None, &ToolCallSource::Direct),
                "{helper}"
            );
        }
    }

    #[test]
    fn mcp_calls_count_except_passive_browser_tools() {
        assert!(mcp_tool_counts_as_execution("project_db", "query"));
        assert!(mcp_tool_counts_as_execution(
            "instafy_local_browser",
            "observe"
        ));
        for server in BROWSER_MCP_SERVER_NAMES {
            for tool in BROWSER_EXECUTION_TOOL_NAMES {
                assert!(
                    mcp_tool_counts_as_execution(server, tool),
                    "{server}.{tool}"
                );
            }
            for tool in ["status", "request_human_input"] {
                assert!(
                    !mcp_tool_counts_as_execution(server, tool),
                    "{server}.{tool}"
                );
            }
        }
        // Without a captured MCP context the namespace still identifies the server.
        assert!(tool_counts_as_execution(
            &ToolName::namespaced("mcp__instafy_personal_browser__", "click"),
            None,
            &ToolCallSource::Direct
        ));
        assert!(!tool_counts_as_execution(
            &ToolName::namespaced("mcp__instafy_personal_browser__", "status"),
            None,
            &ToolCallSource::Direct
        ));
        assert!(tool_counts_as_execution(
            &ToolName::namespaced("mcp__project_db__", "query"),
            None,
            &ToolCallSource::Direct
        ));
    }
}
