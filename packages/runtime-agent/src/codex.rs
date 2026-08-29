use std::collections::{HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use codex_config::{DEFAULT_MCP_SERVER_ENVIRONMENT_ID, McpServerConfig, McpServerTransportConfig};
use codex_core::config::{
    Config, ConfigBuilder, ConfigOverrides, ManagedFeatures, find_codex_home,
    set_project_trust_level,
};
use codex_core::test_support::EmptyUserInstructionsProvider;
use codex_core::{
    CodexAppsToolsCache, CodexThread, NewThread, SteerInputError, ThreadManager,
    build_models_manager, init_state_db, local_agent_graph_store_from_state_db,
    resolve_installation_id, thread_store_from_config,
};
use codex_exec_server::{EnvironmentManager, LOCAL_ENVIRONMENT_ID, LOCAL_FS};
use codex_extension_api::empty_extension_registry;
use codex_features::Feature;
use codex_git_utils::resolve_root_git_project_for_trust;
use codex_login::AuthManager;
use codex_login::default_client::set_default_originator;
use codex_model_provider_info::WireApi;
use codex_protocol::ThreadId;
use codex_protocol::config_types::{
    EnvironmentVariablePattern, SandboxMode, ShellEnvironmentPolicy, TrustLevel, WebSearchMode,
};
use codex_protocol::error::Result as CodexResult;
use codex_protocol::items::{AgentMessageContent, TurnItem};
use codex_protocol::models::{ContentItem, MessagePhase, ResponseItem};
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::{
    AskForApproval, CodexErrorInfo, Event, EventMsg, McpServerRefreshConfig, Op, SandboxPolicy,
    SessionSource, ThreadSettingsOverrides, TurnEnvironmentSelection, TurnEnvironmentSelections,
};
use codex_protocol::user_input::UserInput;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::{LegacyAppPathString, PathUri};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::active_turn_input::{
    ActiveTurnInputCommand, ActiveTurnInputOutcome, ActiveTurnInputReceiver,
};

use crate::job_cancel::JobCancelSignal;
use crate::model_environment::{
    INTERNAL_CREDENTIAL_ENV_KEYS, MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS,
    is_model_child_excluded_env_key,
};
use crate::personal_browser::{
    CONTROL_TOKEN_ENV as PERSONAL_BROWSER_CONTROL_TOKEN_ENV,
    CONTROL_URL_ENV as PERSONAL_BROWSER_CONTROL_URL_ENV,
    PROJECT_ID_ENV as PERSONAL_BROWSER_PROJECT_ID_ENV, RUNTIME_AGENT_BIN_ENV,
};
use crate::shared_browser::{
    ACTIONS_FILE_ENV as SHARED_BROWSER_ACTIONS_FILE_ENV,
    AGENT_CONTROL_FILE_ENV as SHARED_BROWSER_AGENT_CONTROL_FILE_ENV,
    APPROVAL_DIR_ENV as SHARED_BROWSER_APPROVAL_DIR_ENV,
    APPROVAL_TIMEOUT_MS_ENV as SHARED_BROWSER_APPROVAL_TIMEOUT_MS_ENV,
    BROWSER_SESSION_ENV as SHARED_BROWSER_SESSION_ENV, CDP_PORT_ENV as SHARED_BROWSER_CDP_PORT_ENV,
    CDP_URL_ENV as SHARED_BROWSER_CDP_URL_ENV, MCP_COMMAND as SHARED_BROWSER_MCP_COMMAND,
    PAGE_ID_ENV as SHARED_BROWSER_PAGE_ID_ENV,
    PLAYWRIGHT_MODULE_PATH_ENV as SHARED_BROWSER_PLAYWRIGHT_MODULE_PATH_ENV,
    TRUSTED_NODE_MODULES_ROOT_ENV as SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT_ENV,
};

const DEFAULT_CODEX_MODEL: &str = "gpt-5.6-sol";
const DEFAULT_CODEX_RUN_TIMEOUT_SECONDS: u64 = 600;
const DEFAULT_CODEX_MAX_RUN_RETRIES: usize = 1;
const DEFAULT_CODEX_RETRY_BASE_DELAY_MS: u64 = 1500;
const DEFAULT_CODEX_CANCEL_SHUTDOWN_TIMEOUT_SECONDS: u64 = 5;
const SHARED_BROWSER_CONFIRMED_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
const SHARED_BROWSER_EXECUTION_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_COMMAND_OUTPUT_EVENT_CHARS: usize = 4096;
const MAX_COMMAND_OUTPUT_BUFFER_CHARS: usize = 8192;
const BROWSER_MODE_DEVELOPER_INSTRUCTIONS: &str = r#"Browser/UI execution run:
- Use project memory, pinned skills, and loaded learned blocks as the source of task behavior. This prompt only defines run-level invariants.
- Use the dedicated browser tools configured for this turn when browser execution was requested.
- Keep the visible page open and focused. Report only concrete observed state or exact execution errors."#;
const SHARED_BROWSER_DEVELOPER_INSTRUCTIONS: &str = r#"Shared Browser transport (managed runtime policy):
- A headed browser in the project's isolated hosted runtime is available. Use the dedicated tools from the `instafy_shared_browser` MCP server: `status`, `snapshot`, `navigate`, `click`, `type`, `press`, and `scroll`.
- Take a snapshot and pass both its `snapshotId` and one indexed element to each interaction. If the page or indexed target set changes, take another snapshot instead of retrying a stale target. Arbitrary CSS selectors are not accepted.
- Do not invoke Shared Browser through shell commands or write an ad-hoc Playwright/CDP script. The capability is deliberately exposed only through the bounded MCP server for this turn.
- The controller automatically emits the visible AI cursor and action-ticker events. Do not bypass it.
- Never type authentication, payment, or identity secrets. Stop and ask the user to enter them directly.
- The authenticated initiating user approves each site for this run. Every explicit navigation, interactive click, typed-text operation, form submission, and key press also pauses for a short-lived **Allow once** decision, independent of the control's language or label.
- A denial, timeout, stale target, changed page, or replayed approval is final for that attempted action. Do not retry it automatically; report the exact returned error and wait for a new user instruction.
- Approval is never a model-visible tool. Do not search for, inspect, edit, or simulate runtime approval files."#;
const PERSONAL_BROWSER_DEVELOPER_INSTRUCTIONS: &str = r#"Personal Browser transport (managed runtime policy):
- A private browser embedded in the user's desktop app is available to this runtime. Use it for browser work instead of Playwright, CDP, noVNC, or a hosted browser.
- Use the dedicated tools from the `instafy_personal_browser` MCP server: `status`, `snapshot`, `navigate`, `click`, `type`, `press`, and `scroll`. Do not invoke Personal Browser through shell commands.
- The broker currently controls one visible page. Reuse it and navigate sequentially; do not invent tab/window endpoints or silently switch to a hosted/shared browser.
- Get interactive element indices from `snapshot`, then use one fresh index for exactly one click/type/press action. Snapshot again before every subsequent indexed action and after navigation, scrolling, or DOM changes. Arbitrary CSS selectors are not accepted.
- The Personal Browser capability is deliberately unavailable to shell tools and subprocesses. Never try to discover, print, persist, or reconstruct it.
- Stop on a 423 response because the user paused control. Stop on 401 because the session capability was rotated or revoked; do not inspect or retry the token."#;
const MCP_MODE_DEVELOPER_INSTRUCTIONS: &str = "MCP-focused run: complete the task via real MCP function calls, not shell emulation. Your first executable action should be an MCP tool call from the discovered MCP tool inventory in this run. Never execute MCP tool names through shell commands.";
const STRUCTURED_RUNTIME_DEVELOPER_INSTRUCTIONS: &str = r#"Instafy Studio structured execution run:
- Treat this as a background automation job, not an interactive chat turn.
- Do not send progress-only assistant messages as the final response.
- Apply relevant skills silently. If a prompt includes a skill snapshot or compact workspace memory, treat that as already loaded; do not send a separate skill-use announcement.
- Complete the latest request before replying. Use tool calls when they are needed to observe the workspace or produce concrete results.
- When runtime metadata marks command execution as required, call the runtime command tool (`exec_command` or `shell`) before the final response. Do not only reason about the command.
- If command tools are unavailable or fail before execution, return the concrete blocker in the required final JSON object.
- For file-only create/edit/delete requests, inline `files[]` entries with full content are a valid runtime write path and do not require `exec_command` or `shell`.
- If the request cannot be completed, return the concrete blocker in the required final JSON object."#;
const PLAIN_FINAL_RUNTIME_DEVELOPER_INSTRUCTIONS: &str = r#"Instafy Studio focused execution run:
- Treat this as a background automation job, not an interactive chat turn.
- Do not send progress-only assistant messages as the final response.
- Apply relevant skills silently. If a prompt includes focused observations, compact workspace memory, or loaded learned blocks, treat that material as already loaded.
- Complete the latest request before replying. Use tool calls only when they are needed to observe evidence not already provided.
- Finish with a normal final assistant message. Do not wrap the final answer in JSON unless the latest request explicitly asks for JSON."#;
const STRUCTURED_RUNTIME_BASE_INSTRUCTIONS: &str = r#"You are Codex running inside Instafy Studio as a non-interactive background automation agent.

Complete the user's latest request using the available tools. Do not emit interim progress, preamble, or status-only assistant messages. If work requires observing the workspace, use tool calls before answering.

Apply skills silently. When the prompt includes a focused skill snapshot, compact workspace memory, or loaded learned blocks, treat that material as already loaded unless the latest request explicitly asks you to re-read it.

When runtime context marks command execution as required, invoke the available runtime command tool (`exec_command` or `shell`) before answering. If no command tool can be called, say that explicitly in the final JSON `summary`; do not end the turn with reasoning only.

The final assistant message must be exactly one JSON object matching the required output schema. Put user-facing prose in the JSON `summary` field. Include `files` entries only for concrete workspace files that were created, changed, read as primary evidence, or otherwise need to be surfaced to the user.
For file-only create/edit/delete requests, returning inline `files[]` entries with full `content` or `contentBase64` is an executable runtime write path and does not require `exec_command` or `shell`.
"#;
const PLAIN_FINAL_RUNTIME_BASE_INSTRUCTIONS: &str = r#"You are Codex running inside Instafy Studio as a non-interactive background automation agent.

Complete the user's latest request using the available evidence and tools. Do not emit interim progress, preamble, or status-only assistant messages.

Apply skills silently. When the prompt includes focused observations, compact workspace memory, or loaded learned blocks, treat that material as already loaded unless the latest request explicitly asks you to re-read it.

If work requires observing workspace/runtime state that was not already provided, invoke the available runtime command tool (`exec_command` or `shell`) for that observation. If no command tool can be called, say that explicitly in the final answer.

The final assistant message should be normal user-facing prose. Do not wrap it in JSON unless the latest request explicitly asks for JSON.
"#;
const PLAIN_WRITE_RUNTIME_DEVELOPER_INSTRUCTIONS: &str = r#"Instafy Studio workspace-change run:
- Treat this as a background automation job, not an interactive chat turn.
- Make the requested file changes directly with `apply_patch` (or write the files). Read files first with the available tools when you need current content before editing.
- Do not send progress-only assistant messages as the final response.
- Apply relevant skills silently. If a prompt includes a skill snapshot or compact workspace memory, treat that as already loaded.
- Always end the turn with a final assistant message — never stop after reasoning alone. Finish with a short, normal summary of what you changed. Do not wrap the final answer in JSON, and do not paste full file contents — the runtime derives the changed-file list and diff from the workspace itself.
- If the request cannot be completed as stated (for example a referenced file or page does not exist), do not end silently: say what you found and either take the closest useful action (such as creating the missing file) or state clearly what is blocking it."#;
const PLAIN_WRITE_RUNTIME_BASE_INSTRUCTIONS: &str = r#"You are Codex running inside Instafy Studio as a non-interactive background automation agent completing a workspace-change request.

Make the requested changes directly in the workspace using your file-editing tools (`apply_patch`). Inspect files with the available tools when you need to see current content before editing. Do not emit interim progress, preamble, or status-only assistant messages.

Apply skills silently. When the prompt includes a focused skill snapshot, compact workspace memory, or loaded learned blocks, treat that material as already loaded unless the latest request explicitly asks you to re-read it.

When you have applied the changes, finish with a short, normal user-facing assistant message summarizing what you changed (files touched and any important caveats). Do not wrap the final answer in JSON, and do not restate full file contents — the runtime detects the actual file changes from the workspace itself.

Always end the turn with a final assistant message; never stop after reasoning alone. If the request cannot be completed as stated — for example a referenced file or page does not exist in the workspace — do not stop silently: briefly say what you found and either take the closest useful action (such as creating the missing file) or state clearly what is blocking it.
"#;
const CODEX_STATE_DEFAULT_THREAD_ID_KEY: &str = "defaultThreadId";
const CODEX_STATE_BROWSER_THREAD_ID_KEY: &str = "browserThreadId";
const CODEX_STATE_LEGACY_THREAD_ID_KEY: &str = "threadId";
const CODEX_STATE_DEFAULT_ROLLOUT_PATH_KEY: &str = "defaultRolloutPath";
const CODEX_STATE_BROWSER_ROLLOUT_PATH_KEY: &str = "browserRolloutPath";
const CODEX_STATE_LEGACY_ROLLOUT_PATH_KEY: &str = "rolloutPath";
const CODEX_STATE_DEFAULT_THREAD_RESTORE_FAILED_KEY: &str = "defaultThreadRestoreFailed";
const CODEX_STATE_BROWSER_THREAD_RESTORE_FAILED_KEY: &str = "browserThreadRestoreFailed";
const CODEX_STATE_DEFAULT_THREAD_RESTORE_SOURCE_KEY: &str = "defaultThreadRestoreSource";
const CODEX_STATE_BROWSER_THREAD_RESTORE_SOURCE_KEY: &str = "browserThreadRestoreSource";
const CODEX_STATE_LAST_RESTORE_SOURCE_KEY: &str = "lastThreadRestoreSource";
const CODEX_STATE_HISTORY_REPLAY_REQUIRED_KEY: &str = "historyReplayRequired";
const CODEX_STATE_PROVIDER_KEY: &str = "provider";
const CODEX_STATE_VERSION_KEY: &str = "version";
const CODEX_REQUIRED_TOOL_METADATA_KEY: &str = "codex.required_tool";
const PERSONAL_BROWSER_MCP_SERVER_NAME: &str = "instafy_personal_browser";
const SHARED_BROWSER_MCP_SERVER_NAME: &str = "instafy_shared_browser";
const BROWSER_MCP_TOOL_NAMES: [&str; 7] = [
    "status", "snapshot", "navigate", "click", "type", "press", "scroll",
];
const CODEX_REQUIRED_TOOL_COMMAND_ONCE: &str = "command_once";
const MISSING_FINAL_ASSISTANT_MESSAGE_SUMMARY: &str =
    "Codex automation completed, but no final assistant message was returned.";
const INVALID_FINAL_ASSISTANT_MESSAGE_JSON_SUMMARY_PREFIX: &str =
    "Codex automation completed, but the final assistant message was not valid JSON.";
const COMMENTARY_ONLY_FINAL_ASSISTANT_MESSAGE_SUMMARY_PREFIX: &str = "Codex automation stopped after a progress/commentary message without returning a final assistant message.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodexFallbackSummaryKind {
    MissingFinalAssistantMessage,
    InvalidFinalAssistantMessageJson,
}

pub(crate) fn classify_internal_codex_fallback_summary(
    summary: &str,
) -> Option<CodexFallbackSummaryKind> {
    let trimmed = summary.trim();
    if trimmed == MISSING_FINAL_ASSISTANT_MESSAGE_SUMMARY {
        return Some(CodexFallbackSummaryKind::MissingFinalAssistantMessage);
    }
    if trimmed.starts_with(COMMENTARY_ONLY_FINAL_ASSISTANT_MESSAGE_SUMMARY_PREFIX) {
        return Some(CodexFallbackSummaryKind::MissingFinalAssistantMessage);
    }
    if trimmed.starts_with(INVALID_FINAL_ASSISTANT_MESSAGE_JSON_SUMMARY_PREFIX) {
        return Some(CodexFallbackSummaryKind::InvalidFinalAssistantMessageJson);
    }
    None
}

fn normalize_runtime_codex_model_id(model: &str) -> String {
    match model.trim() {
        "" => DEFAULT_CODEX_MODEL.to_string(),
        // Older persisted Studio agent settings can still point at retired Codex
        // model ids even after the frontend option list is migrated.
        trimmed if is_retired_runtime_codex_model_id(trimmed) => DEFAULT_CODEX_MODEL.to_string(),
        trimmed => trimmed.to_string(),
    }
}

fn is_retired_runtime_codex_model_id(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
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

fn default_final_output_json_schema() -> JsonValue {
    serde_json::from_str(
        r#"{
          "type": "object",
          "additionalProperties": false,
          "required": ["summary", "code", "suggestions", "files", "actions"],
          "properties": {
            "summary": { "type": "string" },
            "code": { "type": ["string", "null"] },
            "suggestions": {
              "type": ["array", "null"],
              "items": { "type": "string" }
            },
            "files": {
              "type": ["array", "null"],
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "path",
                  "id",
                  "workspacePath",
                  "label",
                  "description",
                  "mimeType",
                  "content",
                  "contentBase64",
                  "content_base64",
                  "change",
                  "type",
                  "lines"
                ],
                "properties": {
                  "path": { "type": ["string", "null"] },
                  "id": { "type": ["string", "null"] },
                  "workspacePath": { "type": ["string", "null"] },
                  "label": { "type": ["string", "null"] },
                  "description": { "type": ["string", "null"] },
                  "mimeType": { "type": ["string", "null"] },
                  "content": { "type": ["string", "null"] },
                  "contentBase64": { "type": ["string", "null"] },
                  "content_base64": { "type": ["string", "null"] },
                  "type": { "type": ["string", "null"] },
                  "lines": {
                    "type": ["array", "null"],
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": ["from", "to"],
                      "properties": {
                        "from": { "type": ["integer", "null"] },
                        "to": { "type": ["integer", "null"] }
                      }
                    }
                  },
                  "change": {
                    "type": ["object", "string", "null"],
                    "additionalProperties": false,
                    "required": ["type", "lines"],
                    "properties": {
                      "type": { "type": ["string", "null"] },
                      "lines": {
                        "type": ["array", "null"],
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "required": ["from", "to"],
                          "properties": {
                            "from": { "type": ["integer", "null"] },
                            "to": { "type": ["integer", "null"] }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            "actions": {
              "type": ["array", "null"],
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "type",
                  "name",
                  "description",
                  "provider",
                  "precision",
                  "requiredScopes",
                  "capabilities",
                  "authMethods",
                  "suggestedSecretNames",
                  "suggestedSecrets",
                  "agentHandles"
                ],
                "properties": {
                  "type": { "type": "string" },
                  "name": { "type": ["string", "null"] },
                  "description": { "type": ["string", "null"] },
                  "provider": { "type": ["string", "null"] },
                  "precision": { "type": ["string", "null"] },
                  "requiredScopes": {
                    "type": ["array", "null"],
                    "items": { "type": "string" }
                  },
                  "capabilities": {
                    "type": ["array", "null"],
                    "items": { "type": "string" }
                  },
                  "authMethods": {
                    "type": ["array", "null"],
                    "items": { "type": "string" }
                  },
                  "suggestedSecretNames": {
                    "type": ["array", "null"],
                    "items": { "type": "string" }
                  },
                  "suggestedSecrets": {
                    "type": ["array", "null"],
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": ["name", "description"],
                      "properties": {
                        "name": { "type": "string" },
                        "description": { "type": ["string", "null"] }
                      }
                    }
                  },
                  "agentHandles": {
                    "type": ["array", "null"],
                    "items": { "type": "string" }
                  }
                }
              }
            }
          }
        }"#,
    )
    .expect("default final output schema must be valid JSON")
}

fn multi_agent_plan_final_output_json_schema() -> JsonValue {
    serde_json::from_str(
        r#"{
          "type": "object",
          "additionalProperties": false,
          "required": ["summary", "files", "actions"],
          "properties": {
            "summary": { "type": "string" },
            "files": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "workspacePath", "content", "contentBase64", "change"],
                "properties": {
                  "path": { "type": ["string", "null"] },
                  "workspacePath": { "type": ["string", "null"] },
                  "content": { "type": ["string", "null"] },
                  "contentBase64": { "type": ["string", "null"] },
                  "change": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["type"],
                    "properties": {
                      "type": { "type": ["string", "null"] }
                    }
                  }
                }
              }
            },
            "actions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "type",
                  "rationale",
                  "thresholdReason",
                  "mode",
                  "handoffPaths",
                  "agents",
                  "lead",
                  "runtimeRouting",
                  "presentation"
                ],
                "properties": {
                  "type": { "type": "string" },
                  "rationale": { "type": "string" },
                  "thresholdReason": { "type": "string" },
                  "mode": { "type": "string" },
                  "handoffPaths": {
                    "type": ["array", "null"],
                    "items": { "type": "string" }
                  },
                  "agents": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": ["handle", "label", "prompt", "scopeSummary", "writeScope"],
                      "properties": {
                        "handle": { "type": "string" },
                        "label": { "type": "string" },
                        "prompt": { "type": "string" },
                        "scopeSummary": { "type": "string" },
                        "writeScope": {
                          "type": ["object", "null"],
                          "additionalProperties": false,
                          "required": ["mode", "readOnlyPaths", "ownedPaths", "ownedPathGlobs", "rationale"],
                          "properties": {
                            "mode": { "type": ["string", "null"] },
                            "readOnlyPaths": {
                              "type": ["array", "null"],
                              "items": { "type": "string" }
                            },
                            "ownedPaths": {
                              "type": ["array", "null"],
                              "items": { "type": "string" }
                            },
                            "ownedPathGlobs": {
                              "type": ["array", "null"],
                              "items": { "type": "string" }
                            },
                            "rationale": { "type": ["string", "null"] }
                          }
                        }
                      }
                    }
                  },
                  "lead": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["leadHandle", "continuationPrompt", "expectedReportFormat"],
                    "properties": {
                      "leadHandle": { "type": "string" },
                      "continuationPrompt": { "type": "string" },
                      "expectedReportFormat": { "type": "string" }
                    }
                  },
                  "runtimeRouting": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["strategy", "desiredSlots", "rationale"],
                    "properties": {
                      "strategy": { "type": ["string", "null"] },
                      "desiredSlots": { "type": ["integer", "null"] },
                      "rationale": { "type": ["string", "null"] }
                    }
                  },
                  "presentation": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["workerEvidenceVisibility", "leadSummaryVisibility", "showThresholdReason"],
                    "properties": {
                      "workerEvidenceVisibility": { "type": ["string", "null"] },
                      "leadSummaryVisibility": { "type": ["string", "null"] },
                      "showThresholdReason": { "type": ["boolean", "null"] }
                    }
                  }
                }
              }
            }
          }
        }"#,
    )
    .expect("multi-agent final output schema must be valid JSON")
}

fn routing_preflight_final_output_json_schema() -> JsonValue {
    serde_json::from_str(
        r#"{
          "type": "object",
          "additionalProperties": false,
          "required": ["summary", "route", "reason", "selectedSkills", "confidence", "requiresContextLookup", "requiresCommandExecution", "requiresWorkspaceFileChanges", "observationCommands"],
          "properties": {
            "summary": { "type": "string" },
            "route": { "type": "string" },
            "reason": { "type": "string" },
            "selectedSkills": {
              "type": "array",
              "items": { "type": "string" }
            },
            "confidence": { "type": "integer" },
            "requiresContextLookup": { "type": "boolean" },
            "requiresCommandExecution": { "type": "boolean" },
            "requiresWorkspaceFileChanges": { "type": "boolean" },
            "observationCommands": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        }"#,
    )
    .expect("routing preflight final output schema must be valid JSON")
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CodexFinalOutputSchema {
    #[default]
    Default,
    MultiAgentPlan,
    RoutingPreflight,
}

fn final_output_json_schema_for_run(
    wire_api: WireApi,
    _disable_shell_tool: bool,
    disable_final_output_json_schema: bool,
    schema: CodexFinalOutputSchema,
) -> Option<JsonValue> {
    if disable_final_output_json_schema || wire_api != WireApi::Responses {
        return None;
    }

    if bool_from_env("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA").unwrap_or(false) {
        return None;
    }

    Some(match schema {
        CodexFinalOutputSchema::Default => default_final_output_json_schema(),
        CodexFinalOutputSchema::MultiAgentPlan => multi_agent_plan_final_output_json_schema(),
        CodexFinalOutputSchema::RoutingPreflight => routing_preflight_final_output_json_schema(),
    })
}

#[derive(Debug, Clone)]
pub struct CodexConfig {
    pub workspace_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CodexClient {
    config: CodexConfig,
}

#[derive(Debug)]
pub struct CodexRunOutput {
    pub final_json: JsonValue,
    pub events: Vec<JsonValue>,
    pub provider_conversation_state: Option<JsonValue>,
}

#[derive(Debug, Clone, Default)]
pub struct CodexRunOptions {
    pub disable_shell_tool: bool,
    pub disable_final_output_json_schema: bool,
    pub final_output_schema: CodexFinalOutputSchema,
    pub expect_browser_session: bool,
    pub personal_browser: bool,
    pub shared_browser: bool,
    pub shared_browser_page_id: Option<String>,
    pub expect_mcp_tools: bool,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub suppress_contextual_instructions: bool,
    pub persist_conversation_thread: bool,
    pub provider_conversation_state: Option<JsonValue>,
    pub allow_plain_text_final_fallback: bool,
    // When set alongside a plain-text final mode, the model is instructed to make workspace
    // file changes with apply_patch and then finish with a natural summary — distinct from the
    // read-only "report" plain-text mode which discourages mutations.
    pub plain_text_write_mode: bool,
    pub require_first_tool_call: bool,
    pub cancel_signal: Option<JobCancelSignal>,
    pub active_turn_input: Option<ActiveTurnInputReceiver>,
}

async fn run_on_fresh_task<T, F>(future: F) -> T
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    // Awaiting a directly spawned task gives Codex's large debug-build futures a fresh poll stack.
    // The guard aborts that task if its caller is cancelled, and child panics are resumed below,
    // preserving the cancellation/panic/error behavior of a direct await.
    let mut task = AbortTaskOnDrop::new(tokio::spawn(future));
    let result = task.handle_mut().await;
    task.disarm();
    match result {
        Ok(output) => output,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => panic!("Codex task was cancelled unexpectedly: {error}"),
    }
}

struct AbortTaskOnDrop<T> {
    handle: Option<JoinHandle<T>>,
}

impl<T> AbortTaskOnDrop<T> {
    fn new(handle: JoinHandle<T>) -> Self {
        Self {
            handle: Some(handle),
        }
    }

    fn handle_mut(&mut self) -> &mut JoinHandle<T> {
        self.handle
            .as_mut()
            .expect("Codex task handle is unavailable")
    }

    fn disarm(&mut self) {
        self.handle.take();
    }
}

impl<T> Drop for AbortTaskOnDrop<T> {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

async fn start_codex_thread(
    thread_manager: Arc<ThreadManager>,
    config: Config,
) -> CodexResult<NewThread> {
    run_on_fresh_task(async move { thread_manager.start_thread(config).await }).await
}

async fn resume_codex_thread(
    thread_manager: Arc<ThreadManager>,
    config: Config,
    rollout_path: PathBuf,
    auth_manager: Arc<AuthManager>,
) -> CodexResult<NewThread> {
    run_on_fresh_task(async move {
        thread_manager
            .resume_thread_from_rollout(config, rollout_path, auth_manager, None, false)
            .await
    })
    .await
}

impl CodexClient {
    pub fn new(config: CodexConfig) -> Self {
        Self { config }
    }

    pub fn from_env(workspace_dir: &Path) -> Option<Self> {
        if bool_from_env("CODEX_DISABLED") == Some(true) {
            return None;
        }

        Some(Self::new(CodexConfig {
            workspace_dir: workspace_dir.to_path_buf(),
        }))
    }

    pub fn workspace_dir(&self) -> &Path {
        &self.config.workspace_dir
    }

    pub async fn execute(
        &self,
        prompt: &str,
        on_event: Option<&mut (dyn FnMut(&JsonValue) -> Result<()> + Send)>,
    ) -> Result<CodexRunOutput> {
        self.execute_with_options(prompt, on_event, CodexRunOptions::default())
            .await
    }

    pub async fn execute_with_options(
        &self,
        prompt: &str,
        mut on_event: Option<&mut (dyn FnMut(&JsonValue) -> Result<()> + Send)>,
        options: CodexRunOptions,
    ) -> Result<CodexRunOutput> {
        let run_timeout = resolve_codex_run_timeout();
        let max_retries = resolve_codex_max_run_retries();
        let retry_base_delay = resolve_codex_retry_base_delay();

        let mut attempt: usize = 0;
        loop {
            let mut attempt_options = options.clone();
            let shared_browser_cancel_signal = if attempt_options.shared_browser {
                let signal = attempt_options
                    .cancel_signal
                    .clone()
                    .unwrap_or_else(JobCancelSignal::new);
                signal.reset_shared_browser_shutdown_confirmation();
                attempt_options.cancel_signal = Some(signal.clone());
                Some(signal)
            } else {
                None
            };
            let shared_browser_shutdown_confirmation = shared_browser_cancel_signal.clone();
            let result = if on_event.is_none() {
                // Callback-free production runs own every input needed by execute_inner, so they
                // can use a fresh task stack. Callback-bearing runs retain the direct path because
                // the borrowed callback is intentionally non-'static.
                let client = Self::new(self.config.clone());
                let prompt = prompt.to_string();
                let options = attempt_options;
                run_on_fresh_task(async move {
                    let mut no_event_callback = None;
                    if let Some(cancel_signal) = shared_browser_cancel_signal {
                        Ok(Self::run_shared_browser_with_deadline(
                            run_timeout,
                            SHARED_BROWSER_EXECUTION_DRAIN_TIMEOUT,
                            cancel_signal,
                            client.execute_inner(&prompt, &mut no_event_callback, options),
                        )
                        .await)
                    } else {
                        timeout(
                            run_timeout,
                            client.execute_inner(&prompt, &mut no_event_callback, options),
                        )
                        .await
                    }
                })
                .await
            } else {
                if let Some(cancel_signal) = shared_browser_cancel_signal {
                    Ok(Self::run_shared_browser_with_deadline(
                        run_timeout,
                        SHARED_BROWSER_EXECUTION_DRAIN_TIMEOUT,
                        cancel_signal,
                        self.execute_inner(prompt, &mut on_event, attempt_options),
                    )
                    .await)
                } else {
                    timeout(
                        run_timeout,
                        self.execute_inner(prompt, &mut on_event, attempt_options),
                    )
                    .await
                }
            };
            if shared_browser_shutdown_confirmation
                .as_ref()
                .is_some_and(|signal| !signal.shared_browser_shutdown_is_confirmed())
            {
                return Err(anyhow!(
                    "Shared Browser execution ended without confirmed tool shutdown; runtime recycle required"
                ));
            }
            match result {
                Ok(Ok(output)) => return Ok(output),
                Ok(Err(error)) => {
                    let error_text = format!("{error:#}");
                    let should_retry = attempt < max_retries && should_retry_codex_run(&error_text);
                    if !should_retry {
                        return Err(error);
                    }

                    let delay = codex_retry_delay(retry_base_delay, attempt);
                    tracing::warn!(
                        attempt = attempt + 1,
                        max_retries,
                        delay_ms = delay.as_millis(),
                        error = %error_text,
                        "Codex run failed with a transient upstream error; retrying"
                    );
                    tokio::time::sleep(delay).await;
                }
                Err(_) => {
                    let should_retry = attempt < max_retries;
                    if !should_retry {
                        return Err(anyhow!("Codex run timed out"));
                    }

                    let delay = codex_retry_delay(retry_base_delay, attempt);
                    tracing::warn!(
                        attempt = attempt + 1,
                        max_retries,
                        delay_ms = delay.as_millis(),
                        timeout_secs = run_timeout.as_secs(),
                        "Codex run timed out; retrying"
                    );
                    tokio::time::sleep(delay).await;
                }
            }
            attempt = attempt.saturating_add(1);
        }
    }

    async fn run_shared_browser_with_deadline<T>(
        run_timeout: Duration,
        cleanup_timeout: Duration,
        cancel_signal: JobCancelSignal,
        future: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        tokio::pin!(future);
        tokio::select! {
            output = &mut future => return output,
            _ = tokio::time::sleep(run_timeout) => {
                cancel_signal.cancel();
            }
            _ = cancel_signal.cancelled() => {}
        }
        // Give cooperative cancellation a bounded window to reach the
        // confirmed-shutdown finalizer. If it cannot, return while the
        // authority marker remains fail-closed; the guard then recycles the
        // runtime instead of leaving the job hung indefinitely.
        timeout(cleanup_timeout, &mut future)
            .await
            .map_err(|_| anyhow!(
                "Shared Browser execution did not reach confirmed shutdown within {} milliseconds after cancellation; runtime recycle required",
                cleanup_timeout.as_millis()
            ))?
    }

    #[allow(unused_assignments)]
    async fn execute_inner(
        &self,
        prompt: &str,
        on_event: &mut Option<&mut (dyn FnMut(&JsonValue) -> Result<()> + Send)>,
        options: CodexRunOptions,
    ) -> Result<CodexRunOutput> {
        let browser_mode = options.expect_browser_session;
        let personal_browser_mode =
            options.personal_browser && personal_browser_capability_is_present();
        let shared_browser_mode = options.shared_browser && shared_browser_capability_is_present();
        let generic_mcp_mode = options.expect_mcp_tools;
        let mcp_mode = generic_mcp_mode || personal_browser_mode || shared_browser_mode;
        let cancel_signal = options.cancel_signal.clone();
        if cancel_signal
            .as_ref()
            .is_some_and(JobCancelSignal::is_canceled)
        {
            return Err(anyhow!("lease lost"));
        }
        tracing::info!(
            browser_mode,
            personal_browser_mode,
            shared_browser_mode,
            mcp_mode,
            generic_mcp_mode,
            expect_mcp_tools = options.expect_mcp_tools,
            disable_shell_tool = options.disable_shell_tool,
            require_first_tool_call = options.require_first_tool_call,
            suppress_contextual_instructions = options.suppress_contextual_instructions,
            "codex run mode flags"
        );
        if let Err(err) = set_default_originator("runtime_agent".to_string()) {
            tracing::warn!(?err, "failed to set Codex originator override");
        }
        cleanup_workspace_local_shell_snapshots(self.workspace_dir());

        let show_raw_reasoning = bool_from_env("CODEX_SHOW_RAW_AGENT_REASONING").unwrap_or(true);
        // Do not force tool-prefix gating in browser-mode runs. Session/tool invariants are
        // enforced here; workflow behavior should come from skills and learned memory.
        let mut cli_overrides = Vec::new();
        if browser_mode {
            // Proxy-backed ChatGPT auth paths can emit compressed request bodies, which some
            // middle proxies in our stack do not decode. Keep browser-mode runs uncompressed.
            cli_overrides.push((
                "features.enable_request_compression".to_string(),
                false.into(),
            ));
        }
        if mcp_mode {
            // MCP-focused turns should not inherit repository/project-doc guidance from AGENTS.md,
            // which can bias the model away from tool-first MCP workflows.
            cli_overrides.push(("project_doc_max_bytes".to_string(), 0.into()));
        }
        if options.suppress_contextual_instructions {
            // Focused background worker retries already carry the bounded evidence and response
            // contract in the prompt. Broad skills/AGENTS scaffolding can consume most of the
            // small visible-output budget before the worker reaches its final answer.
            cli_overrides.push(("project_doc_max_bytes".to_string(), 0.into()));
        }

        let runtime_codex_home = match ensure_runtime_codex_home(self.workspace_dir()) {
            Ok(codex_home) => Some(codex_home),
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    workspace_dir = %self.workspace_dir().display(),
                    "failed to ensure CODEX_HOME before runtime-agent run"
                );
                None
            }
        };

        if let Some(codex_home) =
            runtime_codex_home.or_else(|| find_codex_home().ok().map(|path| path.into()))
        {
            match AbsolutePathBuf::from_absolute_path(self.config.workspace_dir.as_path()) {
                Ok(workspace_root) => {
                    let trust_root =
                        resolve_root_git_project_for_trust(LOCAL_FS.as_ref(), &workspace_root)
                            .await
                            .unwrap_or(workspace_root);
                    if let Err(error) = set_project_trust_level(
                        &codex_home,
                        trust_root.as_path(),
                        TrustLevel::Trusted,
                    ) {
                        tracing::warn!(
                            ?error,
                            codex_home = %codex_home.display(),
                            trust_root = %trust_root.display(),
                            "failed to mark workspace trust root as trusted"
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        ?error,
                        workspace_dir = %self.config.workspace_dir.display(),
                        "failed to resolve absolute workspace path for Codex trust"
                    );
                }
            }
        }

        // Runtime jobs already provide scoped base/developer instructions and workspace skills.
        // Passing a personality for model catalog entries without model_messages can demote useful
        // response items into non-final commentary, which is brittle for background execution.
        let default_personality = None;

        let plain_text_final_mode =
            options.disable_final_output_json_schema && options.allow_plain_text_final_fallback;
        let mode_developer_instructions = if generic_mcp_mode {
            Some(
                optional_env("CODEX_MCP_MODE_DEVELOPER_INSTRUCTIONS")
                    .unwrap_or_else(|| MCP_MODE_DEVELOPER_INSTRUCTIONS.to_string()),
            )
        } else if browser_mode {
            Some(
                optional_env("CODEX_BROWSER_MODE_DEVELOPER_INSTRUCTIONS")
                    .unwrap_or_else(|| BROWSER_MODE_DEVELOPER_INSTRUCTIONS.to_string()),
            )
        } else {
            Some(
                optional_env("CODEX_DEVELOPER_INSTRUCTIONS").unwrap_or_else(|| {
                    if plain_text_final_mode && options.plain_text_write_mode {
                        PLAIN_WRITE_RUNTIME_DEVELOPER_INSTRUCTIONS.to_string()
                    } else if plain_text_final_mode {
                        PLAIN_FINAL_RUNTIME_DEVELOPER_INSTRUCTIONS.to_string()
                    } else {
                        STRUCTURED_RUNTIME_DEVELOPER_INSTRUCTIONS.to_string()
                    }
                }),
            )
        };
        let mode_developer_instructions = mode_developer_instructions
            .map(|instructions| {
                append_shared_browser_developer_instructions(instructions, shared_browser_mode)
            })
            .map(|instructions| {
                append_personal_browser_developer_instructions(instructions, personal_browser_mode)
            });
        let base_instructions = if mcp_mode || browser_mode {
            None
        } else {
            Some(optional_env("CODEX_BASE_INSTRUCTIONS").unwrap_or_else(|| {
                if plain_text_final_mode && options.plain_text_write_mode {
                    PLAIN_WRITE_RUNTIME_BASE_INSTRUCTIONS.to_string()
                } else if plain_text_final_mode {
                    PLAIN_FINAL_RUNTIME_BASE_INSTRUCTIONS.to_string()
                } else {
                    STRUCTURED_RUNTIME_BASE_INSTRUCTIONS.to_string()
                }
            }))
        };

        let overrides = ConfigOverrides {
            model: optional_env("CODEX_MODEL"),
            review_model: None,
            cwd: Some(self.config.workspace_dir.clone()),
            approval_policy: Some(AskForApproval::Never),
            sandbox_mode: Some(resolve_sandbox_mode()),
            personality: default_personality,
            model_provider: optional_env("CODEX_MODEL_PROVIDER"),
            codex_linux_sandbox_exe: optional_env_path("CODEX_LINUX_SANDBOX_EXE"),
            // Runtime-scoped execution turns should not inherit external base instructions.
            base_instructions,
            developer_instructions: mode_developer_instructions,
            show_raw_agent_reasoning: Some(show_raw_reasoning),
            tools_web_search_request: bool_from_env("CODEX_ENABLE_WEB_SEARCH"),
            ..Default::default()
        };

        // Runtime runs strip stale Playwright MCP config because those browser_* tools are not
        // wired in Instafy runtime jobs.
        if let Ok(changed) = repair_codex_config_file(self.workspace_dir()) {
            if changed {
                tracing::info!("sanitized CODEX_HOME config for runtime-agent runs");
            }
        }

        let mut config = match Config::load_with_cli_overrides_and_harness_overrides(
            cli_overrides.clone(),
            overrides.clone(),
        )
        .await
        {
            Ok(config) => config,
            Err(error) => {
                let repaired = match repair_codex_config_file(self.workspace_dir()) {
                    Ok(changed) => changed,
                    Err(repair_error) => {
                        tracing::warn!(
                            error = %repair_error,
                            "failed to repair invalid Codex config prior to reload"
                        );
                        false
                    }
                };

                if repaired {
                    match Config::load_with_cli_overrides_and_harness_overrides(
                        cli_overrides.clone(),
                        overrides.clone(),
                    )
                    .await
                    {
                        Ok(config) => {
                            tracing::info!("loaded Codex configuration after repair");
                            config
                        }
                        Err(reload_error) => {
                            tracing::warn!(
                                initial_error = %error,
                                reload_error = %reload_error,
                                "failed to reload repaired Codex configuration; retrying with fallback CODEX_HOME"
                            );
                            let fallback_home =
                                self.config.workspace_dir.join(".codex-runtime-fallback");
                            let _ =
                                prepare_fallback_codex_home(self.workspace_dir(), &fallback_home);
                            ConfigBuilder::default()
                                .codex_home(fallback_home)
                                .cli_overrides(cli_overrides.clone())
                                .harness_overrides(overrides.clone())
                                .build()
                                .await
                                .map_err(|fallback| anyhow!(fallback))
                                .context("failed to load fallback Codex configuration")?
                        }
                    }
                } else {
                    tracing::warn!(
                        error = %error,
                        "failed to load Codex configuration; retrying with fallback CODEX_HOME"
                    );
                    let fallback_home = self.config.workspace_dir.join(".codex-runtime-fallback");
                    let _ = prepare_fallback_codex_home(self.workspace_dir(), &fallback_home);
                    ConfigBuilder::default()
                        .codex_home(fallback_home)
                        .cli_overrides(cli_overrides.clone())
                        .harness_overrides(overrides.clone())
                        .build()
                        .await
                        .map_err(|fallback| anyhow!(fallback))
                        .context("failed to load fallback Codex configuration")?
                }
            }
        };

        if let Err(error) = ensure_codex_home_writable(config.codex_home.as_path()) {
            tracing::warn!(
                error = %error,
                codex_home = %config.codex_home.display(),
                "loaded Codex home is not usable; retrying with fallback CODEX_HOME"
            );
            let fallback_home = self.config.workspace_dir.join(".codex-runtime-fallback");
            prepare_fallback_codex_home(self.workspace_dir(), &fallback_home)?;
            config = ConfigBuilder::default()
                .codex_home(fallback_home)
                .cli_overrides(cli_overrides.clone())
                .harness_overrides(overrides.clone())
                .build()
                .await
                .map_err(|fallback| anyhow!(fallback))
                .context("failed to load fallback Codex configuration after missing home")?;
        }

        apply_runtime_proxy_model_provider_overrides(&mut config);
        scope_runtime_model_shell_environment(&mut config.permissions.shell_environment_policy);
        install_browser_mcp_servers(
            &mut config,
            options.personal_browser,
            options.shared_browser,
            options.shared_browser_page_id.as_deref(),
        )?;
        scope_browser_capabilities_from_shell_environment(
            &mut config.permissions.shell_environment_policy,
        );
        let normalized_model = normalize_runtime_codex_model_id(
            config.model.as_deref().unwrap_or(DEFAULT_CODEX_MODEL),
        );
        if let Some(current_model) = config.model.as_deref()
            && current_model != normalized_model.as_str()
        {
            tracing::info!(
                from_model = current_model,
                to_model = %normalized_model,
                "normalized runtime Codex model id"
            );
        }
        config.model = Some(normalized_model);

        if !config.mcp_servers.is_empty() && !config.features.enabled(Feature::Apps) {
            let _ = config.features.enable(Feature::Apps);
            tracing::info!(
                mcp_server_count = config.mcp_servers.len(),
                "enabled Apps feature because MCP servers are configured"
            );
        }
        apply_runtime_security_feature_overrides(&mut config.features);
        apply_bounded_browser_security_overrides(
            &mut config,
            personal_browser_mode || shared_browser_mode,
        )?;
        if config.personality.is_some() {
            tracing::info!("disabled Codex personality for runtime-agent background run");
            config.personality = None;
        }
        if options.suppress_contextual_instructions {
            config.include_skill_instructions = false;
            config.include_apps_instructions = false;
            tracing::info!("suppressed broad contextual instructions for focused Codex run");
        }
        clamp_runtime_reasoning_effort(&mut config);
        if let Some(target) = options.reasoning_effort.clone()
            && config.model_reasoning_effort != Some(target.clone())
        {
            tracing::info!(
                from = ?config.model_reasoning_effort,
                to = ?target,
                "raised Codex reasoning effort for this runtime-agent run"
            );
            config.model_reasoning_effort = Some(target);
        }
        // A per-agent reasoning effort (the controller emits it as
        // CODEX_AGENT_REASONING_EFFORT from the agent's `reasoning_effort` column)
        // wins over the runtime clamp and the per-job heuristic above. Applied last
        // so it is authoritative; when the env is absent/empty/unparseable this is a
        // no-op and the existing per-job / global behavior is preserved untouched.
        if let Some(agent_effort) = agent_reasoning_effort_override()
            && config.model_reasoning_effort.as_ref() != Some(&agent_effort)
        {
            tracing::info!(
                from = ?config.model_reasoning_effort,
                to = ?agent_effort,
                "applied per-agent Codex reasoning effort override"
            );
            config.model_reasoning_effort = Some(agent_effort);
        }
        if options.disable_shell_tool {
            // For browser-session jobs we want MCP-first behavior and to avoid shell-script fallbacks.
            // Disable both shell modes (legacy shell + unified exec) and freeform patching.
            let _ = config.features.disable(Feature::ShellTool);
            let _ = config.features.disable(Feature::UnifiedExec);
            let _ = config.features.disable(Feature::ApplyPatchFreeform);
            // Keep browser-mode turns focused on execution tools; AGENTS/project-doc prompts
            // can include generic shell workflows that bias the model away from MCP calls.
            if bool_from_env("CODEX_DEBUG_BROWSER_EVENTS").unwrap_or(false) {
                eprintln!(
                    "[codex-browser-mode] features shell={} unified_exec={} apps={} apply_patch_freeform={} collab={}",
                    config.features.enabled(Feature::ShellTool),
                    config.features.enabled(Feature::UnifiedExec),
                    config.features.enabled(Feature::Apps),
                    config.features.enabled(Feature::ApplyPatchFreeform),
                    config.features.enabled(Feature::Collab),
                );
            }
            tracing::info!("disabled shell and patch tools for this Codex run");
        }
        let server_names: Vec<_> = config.mcp_servers.keys().cloned().collect();
        tracing::info!(
            ?server_names,
            apps_enabled = config.features.enabled(Feature::Apps),
            "loaded MCP servers from Codex config"
        );
        if mcp_mode {
            tracing::info!("using MCP-focused Codex run");
        }
        ensure_codex_home_writable(config.codex_home.as_path()).with_context(|| {
            format!(
                "failed to ensure usable Codex home before state initialization: {}",
                config.codex_home.display()
            )
        })?;
        let auth_manager = AuthManager::shared_from_config(&config, true).await;
        // runtime-agent embeds Codex as a library, so there is no Codex CLI executable
        // available to back exec-server helper re-entry points here.
        let environment_manager = Arc::new(EnvironmentManager::default_for_tests());
        let state_db = init_state_db(&config).await;
        let thread_store = thread_store_from_config(&config, state_db.clone());
        let installation_id = resolve_installation_id(&config.codex_home)
            .await
            .context("failed to resolve Codex installation id")?;
        let thread_manager = Arc::new(ThreadManager::new(
            &config,
            auth_manager.clone(),
            build_models_manager(&config, auth_manager.clone()),
            CodexAppsToolsCache::default(),
            SessionSource::Exec,
            environment_manager,
            empty_extension_registry(),
            Arc::new(EmptyUserInstructionsProvider),
            None,
            thread_store,
            local_agent_graph_store_from_state_db(state_db.as_ref()),
            installation_id,
            None,
            None,
        ));
        let thread_mode_key = thread_mode_key(browser_mode);
        let mut active_thread_id = extract_thread_id_from_provider_state(
            options.provider_conversation_state.as_ref(),
            thread_mode_key,
        );
        let mut active_rollout_path = extract_rollout_path_from_provider_state(
            options.provider_conversation_state.as_ref(),
            thread_mode_key,
        );
        let mut thread_restore_failed = false;
        let mut thread_restore_source = if options.persist_conversation_thread {
            "new".to_string()
        } else {
            "ephemeral".to_string()
        };
        let mut session_configured_event = None;

        let conversation = if options.persist_conversation_thread {
            if let Some(thread_id) = active_thread_id.clone() {
                match thread_manager.get_thread(thread_id).await {
                    Ok(existing) => {
                        thread_restore_source = "memory".to_string();
                        existing
                    }
                    Err(error) => {
                        tracing::warn!(
                            %error,
                            thread_id = %thread_id,
                            mode = thread_mode_key,
                            "persisted Codex thread not found in this runtime; attempting rollout restore"
                        );
                        if let Some(rollout_path) = active_rollout_path.clone() {
                            if rollout_path.exists() {
                                match resume_codex_thread(
                                    Arc::clone(&thread_manager),
                                    config.clone(),
                                    rollout_path.clone(),
                                    auth_manager.clone(),
                                )
                                .await
                                {
                                    Ok(resumed_thread) => {
                                        active_rollout_path =
                                            resumed_thread.session_configured.rollout_path.clone();
                                        session_configured_event =
                                            Some(resumed_thread.session_configured.clone());
                                        active_thread_id = Some(resumed_thread.thread_id);
                                        thread_restore_source = "rollout".to_string();
                                        resumed_thread.thread
                                    }
                                    Err(resume_error) => {
                                        tracing::warn!(
                                            %resume_error,
                                            rollout_path = %rollout_path.display(),
                                            mode = thread_mode_key,
                                            "failed to resume Codex thread from rollout; creating a fresh thread"
                                        );
                                        thread_restore_failed = true;
                                        thread_restore_source = "failed_new".to_string();
                                        let new_thread = start_codex_thread(
                                            Arc::clone(&thread_manager),
                                            config.clone(),
                                        )
                                            .await
                                            .context(
                                                "failed to create replacement Codex thread after restore failure",
                                            )?;
                                        active_rollout_path =
                                            new_thread.session_configured.rollout_path.clone();
                                        session_configured_event =
                                            Some(new_thread.session_configured.clone());
                                        active_thread_id = Some(new_thread.thread_id);
                                        new_thread.thread
                                    }
                                }
                            } else {
                                tracing::warn!(
                                    rollout_path = %rollout_path.display(),
                                    mode = thread_mode_key,
                                    "persisted Codex rollout path missing on disk; creating a fresh thread"
                                );
                                thread_restore_failed = true;
                                thread_restore_source = "failed_new".to_string();
                                let new_thread = start_codex_thread(
                                    Arc::clone(&thread_manager),
                                    config.clone(),
                                )
                                    .await
                                    .context(
                                        "failed to create replacement Codex thread after missing rollout path",
                                    )?;
                                active_rollout_path =
                                    new_thread.session_configured.rollout_path.clone();
                                session_configured_event =
                                    Some(new_thread.session_configured.clone());
                                active_thread_id = Some(new_thread.thread_id);
                                new_thread.thread
                            }
                        } else {
                            tracing::warn!(
                                mode = thread_mode_key,
                                "persisted Codex thread missing and no rollout path was available; creating a fresh thread"
                            );
                            thread_restore_failed = true;
                            thread_restore_source = "failed_new".to_string();
                            let new_thread = start_codex_thread(
                                Arc::clone(&thread_manager),
                                config.clone(),
                            )
                                .await
                                .context(
                                    "failed to create replacement Codex thread after missing thread+rollout state",
                                )?;
                            active_rollout_path =
                                new_thread.session_configured.rollout_path.clone();
                            session_configured_event = Some(new_thread.session_configured.clone());
                            active_thread_id = Some(new_thread.thread_id);
                            new_thread.thread
                        }
                    }
                }
            } else {
                let new_thread = start_codex_thread(Arc::clone(&thread_manager), config.clone())
                    .await
                    .context("failed to create Codex thread")?;
                active_rollout_path = new_thread.session_configured.rollout_path.clone();
                session_configured_event = Some(new_thread.session_configured.clone());
                active_thread_id = Some(new_thread.thread_id);
                thread_restore_source = "new".to_string();
                new_thread.thread
            }
        } else {
            let new_thread = start_codex_thread(Arc::clone(&thread_manager), config.clone())
                .await
                .context("failed to create Codex thread")?;
            active_rollout_path = new_thread.session_configured.rollout_path.clone();
            session_configured_event = Some(new_thread.session_configured.clone());
            active_thread_id = Some(new_thread.thread_id);
            thread_restore_source = "ephemeral".to_string();
            new_thread.thread
        };

        let run_result = async {
            let mut aggregator = CodexEventStreamAdapter::default();
        let mut events = Vec::new();

        if let Some(configured) = session_configured_event {
            let config_event = Event {
                id: "session_configured".to_string(),
                msg: EventMsg::SessionConfigured(configured.clone()),
            };
            if browser_mode && bool_from_env("CODEX_DEBUG_BROWSER_EVENTS").unwrap_or(false) {
                eprintln!(
                    "[codex-browser-mode] session model={} provider={}",
                    configured.model, configured.model_provider_id
                );
            }
            collect_events(&mut aggregator, &config_event, &mut events, on_event)?;
        }

        if should_refresh_mcp_servers(
            mcp_mode,
            personal_browser_mode,
            !config.mcp_servers.is_empty(),
        ) {
            let mcp_servers = serde_json::to_value(&*config.mcp_servers).unwrap_or_else(|err| {
                tracing::warn!(error = %err, "failed to serialize MCP server config for refresh");
                json!({})
            });
            let mcp_oauth_credentials_store_mode = serde_json::to_value(
                config.mcp_oauth_credentials_store_mode,
            )
            .unwrap_or_else(|err| {
                tracing::warn!(
                    error = %err,
                    "failed to serialize MCP OAuth store mode for refresh"
                );
                JsonValue::Null
            });
            let auth_keyring_backend_kind =
                serde_json::to_value(config.auth_keyring_backend_kind()).unwrap_or_else(|err| {
                    tracing::warn!(
                        error = %err,
                        "failed to serialize MCP auth keyring backend kind for refresh"
                    );
                    JsonValue::Null
                });
            conversation
                .submit(Op::RefreshMcpServers {
                    config: McpServerRefreshConfig {
                        mcp_servers,
                        mcp_oauth_credentials_store_mode,
                        auth_keyring_backend_kind,
                    },
                })
                .await
                .context("failed to request MCP server refresh before MCP-focused turn")?;
        }

        let default_cwd = config.cwd.clone();
        // Runtime agent runs in a trusted, non-interactive mode (no approvals).
        let approval_policy = AskForApproval::Never;
        let sandbox_policy = SandboxPolicy::DangerFullAccess;
        let model = config
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_CODEX_MODEL.to_string());
        let final_output_json_schema = final_output_json_schema_for_run(
            config.model_provider.wire_api,
            options.disable_shell_tool,
            options.disable_final_output_json_schema,
            options.final_output_schema,
        );
        let effort = config.model_reasoning_effort;
        let summary = config.model_reasoning_summary;

        let effective_prompt = prompt.to_string();

        let items = vec![UserInput::Text {
            text: effective_prompt,
            // Runtime prompts are plain text with no rich element ranges.
            text_elements: Vec::new(),
        }];

        let requires_structured_final = final_output_json_schema.is_some();

        let responsesapi_client_metadata = options.require_first_tool_call.then(|| {
            HashMap::from([(
                CODEX_REQUIRED_TOOL_METADATA_KEY.to_string(),
                CODEX_REQUIRED_TOOL_COMMAND_ONCE.to_string(),
            )])
        });

        let bounded_browser_mode = personal_browser_mode || shared_browser_mode;
        let active_turn_id = conversation
            .submit(Op::UserInput {
                items,
                final_output_json_schema,
                additional_context: Default::default(),
                responsesapi_client_metadata,
                thread_settings: ThreadSettingsOverrides {
                    // Browser-bound turns deliberately select no execution
                    // environment. MCP tools do not require one, while every
                    // filesystem, image, patch, and shell tool does. Ordinary
                    // runtime turns still need the explicit local selection.
                    environments: Some(turn_environment_selections(
                        default_cwd.clone(),
                        bounded_browser_mode,
                    )),
                    profile_workspace_roots: None,
                    approval_policy: Some(approval_policy),
                    approvals_reviewer: None,
                    sandbox_policy: Some(sandbox_policy),
                    permission_profile: None,
                    active_permission_profile: None,
                    windows_sandbox_level: None,
                    model: Some(model),
                    effort: Some(effort),
                    summary,
                    service_tier: None,
                    collaboration_mode: None,
                    personality: default_personality,
                },
            })
            .await
            .context("failed to submit prompt to Codex")?;

        let mut last_agent_message: Option<String> = None;
        let mut last_agent_message_event: Option<String> = None;
        let mut non_commentary_agent_message_seen = false;
        let mut error_message: Option<String> = None;
        let mut last_stream_error: Option<String> = None;
        let mut fatal_stream_error: Option<String> = None;
        let mut shutdown_requested = false;
        let max_stream_retries = optional_env("CODEX_MAX_STREAM_RETRIES")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(5usize);
        let mut stream_error_count: usize = 0;
        let mut active_turn_input = options.active_turn_input.clone();
        let mut active_turn_input_readiness: Option<ActiveTurnInputReadinessGuard> = None;

        loop {
            let event = if let Some(receiver) = active_turn_input.as_ref() {
                tokio::select! {
                    command = receiver.recv() => {
                        match command {
                            Some(command) => {
                                apply_active_turn_input(&conversation, command).await;
                                continue;
                            }
                            None => {
                                active_turn_input = None;
                                continue;
                            }
                        }
                    }
                    event = next_codex_event(
                        &conversation,
                        cancel_signal.as_ref(),
                        options.shared_browser,
                    ) => event?,
                }
            } else {
                next_codex_event(
                    &conversation,
                    cancel_signal.as_ref(),
                    options.shared_browser,
                )
                .await?
            };
            if browser_mode && bool_from_env("CODEX_DEBUG_BROWSER_EVENTS").unwrap_or(false) {
                eprintln!("[codex-browser-events] event_msg={:?}", &event.msg);
            }
            tracing::debug!(msg = ?event.msg, "received Codex event");

            // `submit` only confirms that the Op reached Codex's channel. Do
            // not advertise steering until Codex proves that this exact
            // submission ID became the live regular turn.
            if active_turn_input_readiness.is_none()
                && event.id == active_turn_id
                && matches!(&event.msg, EventMsg::TurnStarted(_))
            {
                active_turn_input_readiness = Some(ActiveTurnInputReadinessGuard::new(
                    options.active_turn_input.clone(),
                    &active_turn_id,
                ));
            }

            collect_events(&mut aggregator, &event, &mut events, on_event)?;

            match &event.msg {
                EventMsg::TurnComplete(turn) => {
                    if let Some(error) = &turn.error {
                        error_message.get_or_insert(error.message.clone());
                    }
                    let msg = &turn.last_agent_message;
                    if let Some(text) = msg.clone() {
                        if is_unstructured_turn_complete_candidate(
                            requires_structured_final,
                            non_commentary_agent_message_seen,
                            &text,
                        ) {
                            tracing::debug!(
                                message_preview = %text.chars().take(240).collect::<String>(),
                                "retained unstructured turn-complete message as invalid-final candidate"
                            );
                        }
                        last_agent_message.replace(text);
                    }
                    if options.shared_browser || options.persist_conversation_thread {
                        break;
                    }
                    if !options.shared_browser && !shutdown_requested {
                        conversation
                            .submit(Op::Shutdown)
                            .await
                            .context("failed to request Codex shutdown")?;
                        shutdown_requested = true;
                    }
                }
                EventMsg::AgentMessage(agent_message) => {
                    if let Some(text) = agent_message_event_text(agent_message) {
                        non_commentary_agent_message_seen = true;
                        last_agent_message_event = Some(text);
                    }
                }
                EventMsg::ItemCompleted(item_completed) => {
                    if let Some(text) =
                        final_agent_message_text_from_turn_item(&item_completed.item)
                    {
                        non_commentary_agent_message_seen = true;
                        last_agent_message_event = Some(text);
                    }
                }
                EventMsg::RawResponseItem(raw) => {
                    if let Some(text) = assistant_response_item_text(&raw.item) {
                        non_commentary_agent_message_seen = true;
                        last_agent_message_event = Some(text);
                    }
                }
                EventMsg::Error(err) => {
                    error_message.get_or_insert(err.message.clone());
                    if !options.shared_browser && !shutdown_requested {
                        conversation
                            .submit(Op::Shutdown)
                            .await
                            .context("failed to request Codex shutdown after error")?;
                        shutdown_requested = true;
                    }
                    // A Codex error event is terminal for this runtime job. Do not wait for a
                    // ShutdownComplete event that some upstream failure paths never emit.
                    break;
                }
                EventMsg::StreamError(err) => {
                    last_stream_error = Some(err.message.clone());

                    let stream_status_code =
                        err.codex_error_info.as_ref().and_then(|info| match info {
                            CodexErrorInfo::ResponseStreamDisconnected { http_status_code } => {
                                http_status_code.to_owned()
                            }
                            _ => None,
                        });
                    if fatal_stream_error.is_none()
                        && should_terminate_codex_stream(
                            stream_status_code,
                            stream_error_count,
                            max_stream_retries,
                        )
                    {
                        fatal_stream_error = err
                            .additional_details
                            .clone()
                            .or_else(|| Some(err.message.clone()));
                        if !options.shared_browser && !shutdown_requested {
                            conversation
                                .submit(Op::Shutdown)
                                .await
                                .context("failed to request Codex shutdown after stream error")?;
                            shutdown_requested = true;
                        }
                        break;
                    }

                    stream_error_count = stream_error_count.saturating_add(1);
                    if fatal_stream_error.is_none()
                        && should_terminate_codex_stream(
                            stream_status_code,
                            stream_error_count,
                            max_stream_retries,
                        )
                    {
                        let message = format!(
                            "Codex stream aborted after {} retries (limit {}): {}",
                            stream_error_count.saturating_sub(1),
                            max_stream_retries,
                            err.message
                        );
                        fatal_stream_error = Some(message);
                        if !options.shared_browser && !shutdown_requested {
                            conversation
                                .submit(Op::Shutdown)
                                .await
                                .context("failed to request Codex shutdown after stream error")?;
                            shutdown_requested = true;
                        }
                        break;
                    }
                    continue;
                }
                EventMsg::TurnAborted(aborted) => {
                    // An upstream abort previously fell through to `_ => {}`,
                    // leaving the loop idling until the outer timeout and the
                    // turn surfacing as a bare missing-final. Treat it as a
                    // terminal (and retryable) run error instead.
                    let reason = serde_json::to_string(&aborted.reason)
                        .unwrap_or_else(|_| "unknown".to_string())
                        .trim_matches('"')
                        .to_string();
                    error_message.get_or_insert(format!("Codex turn aborted ({reason})"));
                    if !options.shared_browser && !shutdown_requested {
                        conversation
                            .submit(Op::Shutdown)
                            .await
                            .context("failed to request Codex shutdown after turn abort")?;
                        shutdown_requested = true;
                    }
                    break;
                }
                EventMsg::ShutdownComplete => {
                    if !options.persist_conversation_thread {
                        break;
                    }
                }
                _ => {}
            }
        }

        if let Some(message) = fatal_stream_error.or(error_message).or_else(|| {
            if last_agent_message.is_none() {
                last_stream_error.clone()
            } else {
                None
            }
        }) {
            return Err(anyhow!(message));
        }

        let final_json = derive_final_json(
            last_agent_message.as_deref(),
            latest_completed_agent_message_from_events(&events),
            last_agent_message_event.as_deref(),
            latest_completed_agent_commentary_message_from_events(&events),
            latest_completed_reasoning_message_from_events(&events),
            options.allow_plain_text_final_fallback,
        )?;

        let provider_conversation_state = if options.persist_conversation_thread {
            active_thread_id.map(|thread_id| {
                update_provider_conversation_state(
                    options.provider_conversation_state.as_ref(),
                    thread_mode_key,
                    &thread_id,
                    active_rollout_path.as_deref(),
                    thread_restore_failed,
                    &thread_restore_source,
                )
            })
        } else {
            None
        };

            Ok(CodexRunOutput {
                final_json,
                events,
                provider_conversation_state,
            })
        }
        .await;

        if options.shared_browser {
            let Some(shutdown_confirmation) = cancel_signal.as_ref() else {
                return Err(anyhow!(
                    "Shared Browser execution lost its shutdown confirmation signal"
                ));
            };
            confirm_shared_browser_shutdown(&conversation).await?;
            shutdown_confirmation.confirm_shared_browser_shutdown();
        }

        run_result
    }
}

struct ActiveTurnInputReadinessGuard {
    receiver: Option<ActiveTurnInputReceiver>,
}

impl ActiveTurnInputReadinessGuard {
    fn new(receiver: Option<ActiveTurnInputReceiver>, turn_id: &str) -> Self {
        if let Some(receiver) = receiver.as_ref() {
            receiver.set_ready(Some(turn_id.to_string()));
        }
        Self { receiver }
    }
}

impl Drop for ActiveTurnInputReadinessGuard {
    fn drop(&mut self) {
        if let Some(receiver) = self.receiver.as_ref() {
            receiver.set_ready(None);
        }
    }
}

async fn apply_active_turn_input(conversation: &CodexThread, command: ActiveTurnInputCommand) {
    let command_id = command.command_id;
    let items = vec![UserInput::Text {
        text: command.content.clone(),
        text_elements: Vec::new(),
    }];
    let outcome = match conversation
        .steer_input(
            items,
            Default::default(),
            Some(&command.expected_turn_id),
            Some(command_id.to_string()),
            None,
        )
        .await
    {
        Ok(codex_turn_id) => ActiveTurnInputOutcome::Applied { codex_turn_id },
        Err(error) => {
            let error_message = match error {
                SteerInputError::NoActiveTurn(_) => "Codex turn completed before input submission",
                SteerInputError::ExpectedTurnMismatch { .. } => {
                    "Codex active turn changed before input submission"
                }
                SteerInputError::ActiveTurnNotSteerable { .. } => {
                    "Codex active turn does not accept steering input"
                }
                SteerInputError::EmptyInput => "Codex rejected empty steering input",
            };
            ActiveTurnInputOutcome::Rejected {
                error_message: error_message.to_string(),
            }
        }
    };
    command.acknowledge(outcome);
}

async fn confirm_shared_browser_shutdown(conversation: &CodexThread) -> Result<()> {
    timeout(SHARED_BROWSER_CONFIRMED_SHUTDOWN_TIMEOUT, async {
        conversation
            .submit(Op::Shutdown)
            .await
            .context("failed to request confirmed Shared Browser Codex shutdown")?;
        loop {
            let event = conversation
                .next_event()
                .await
                .context("Shared Browser Codex ended before shutdown confirmation")?;
            match event.msg {
                EventMsg::ShutdownComplete => break,
                EventMsg::Error(error) => {
                    return Err(anyhow!(
                        "Shared Browser Codex shutdown could not be confirmed: {}",
                        error.message
                    ));
                }
                _ => {}
            }
        }
        conversation.wait_until_terminated().await;
        Ok::<(), anyhow::Error>(())
    })
    .await
    .map_err(|_| {
        anyhow!(
            "Shared Browser Codex shutdown was not confirmed within {} seconds",
            SHARED_BROWSER_CONFIRMED_SHUTDOWN_TIMEOUT.as_secs()
        )
    })??;
    Ok(())
}

async fn next_codex_event(
    conversation: &CodexThread,
    cancel_signal: Option<&JobCancelSignal>,
    require_complete_shutdown: bool,
) -> Result<Event> {
    if let Some(signal) = cancel_signal {
        tokio::select! {
            _ = signal.cancelled() => {
                if !require_complete_shutdown {
                    request_codex_shutdown(conversation).await;
                }
                Err(anyhow!("lease lost"))
            }
            event = conversation.next_event() => event.context("failed to read Codex event"),
        }
    } else {
        conversation
            .next_event()
            .await
            .context("failed to read Codex event")
    }
}

async fn request_codex_shutdown(conversation: &CodexThread) {
    let timeout_seconds = optional_env("CODEX_CANCEL_SHUTDOWN_TIMEOUT_SECONDS")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CODEX_CANCEL_SHUTDOWN_TIMEOUT_SECONDS);
    match timeout(Duration::from_secs(timeout_seconds), async {
        conversation.submit(Op::Shutdown).await?;
        loop {
            let event = conversation.next_event().await?;
            if matches!(event.msg, EventMsg::ShutdownComplete) {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await
    {
        Ok(Ok(())) => {
            tracing::info!("codex shutdown completed after cancellation");
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "codex shutdown request failed after cancellation");
        }
        Err(_) => {
            tracing::warn!(
                timeout_seconds,
                "codex shutdown timed out after cancellation"
            );
        }
    }
}

fn thread_mode_key(browser_mode: bool) -> &'static str {
    if browser_mode { "browser" } else { "default" }
}

fn extract_thread_id_from_provider_state(
    state: Option<&JsonValue>,
    mode_key: &str,
) -> Option<ThreadId> {
    let candidates = if mode_key.eq_ignore_ascii_case("browser") {
        [
            CODEX_STATE_BROWSER_THREAD_ID_KEY,
            CODEX_STATE_LEGACY_THREAD_ID_KEY,
        ]
    } else {
        [
            CODEX_STATE_DEFAULT_THREAD_ID_KEY,
            CODEX_STATE_LEGACY_THREAD_ID_KEY,
        ]
    };

    for key in candidates {
        if let Some(value) = state
            .and_then(JsonValue::as_object)
            .and_then(|map| map.get(key))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            && let Ok(thread_id) = ThreadId::from_string(value)
        {
            return Some(thread_id);
        }
    }

    if let Some(nested) = state
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("codex"))
    {
        return extract_thread_id_from_provider_state(Some(nested), mode_key);
    }

    None
}

fn rollout_path_state_key(mode_key: &str) -> &'static str {
    if mode_key.eq_ignore_ascii_case("browser") {
        CODEX_STATE_BROWSER_ROLLOUT_PATH_KEY
    } else {
        CODEX_STATE_DEFAULT_ROLLOUT_PATH_KEY
    }
}

fn thread_restore_failed_state_key(mode_key: &str) -> &'static str {
    if mode_key.eq_ignore_ascii_case("browser") {
        CODEX_STATE_BROWSER_THREAD_RESTORE_FAILED_KEY
    } else {
        CODEX_STATE_DEFAULT_THREAD_RESTORE_FAILED_KEY
    }
}

fn thread_restore_source_state_key(mode_key: &str) -> &'static str {
    if mode_key.eq_ignore_ascii_case("browser") {
        CODEX_STATE_BROWSER_THREAD_RESTORE_SOURCE_KEY
    } else {
        CODEX_STATE_DEFAULT_THREAD_RESTORE_SOURCE_KEY
    }
}

fn extract_rollout_path_from_provider_state(
    state: Option<&JsonValue>,
    mode_key: &str,
) -> Option<PathBuf> {
    let candidates = if mode_key.eq_ignore_ascii_case("browser") {
        [
            CODEX_STATE_BROWSER_ROLLOUT_PATH_KEY,
            CODEX_STATE_LEGACY_ROLLOUT_PATH_KEY,
        ]
    } else {
        [
            CODEX_STATE_DEFAULT_ROLLOUT_PATH_KEY,
            CODEX_STATE_LEGACY_ROLLOUT_PATH_KEY,
        ]
    };

    for key in candidates {
        if let Some(value) = state
            .and_then(JsonValue::as_object)
            .and_then(|map| map.get(key))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(PathBuf::from(value));
        }
    }

    if let Some(nested) = state
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("codex"))
    {
        return extract_rollout_path_from_provider_state(Some(nested), mode_key);
    }

    None
}

fn update_provider_conversation_state(
    previous: Option<&JsonValue>,
    mode_key: &str,
    thread_id: &ThreadId,
    rollout_path: Option<&Path>,
    thread_restore_failed: bool,
    thread_restore_source: &str,
) -> JsonValue {
    let mut map = previous
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();

    map.insert(
        CODEX_STATE_PROVIDER_KEY.to_string(),
        JsonValue::String("codex-embedded".to_string()),
    );
    map.insert(
        CODEX_STATE_VERSION_KEY.to_string(),
        JsonValue::Number(2_u64.into()),
    );
    let thread_id_value = JsonValue::String(thread_id.to_string());

    if mode_key.eq_ignore_ascii_case("browser") {
        map.insert(
            CODEX_STATE_BROWSER_THREAD_ID_KEY.to_string(),
            thread_id_value.clone(),
        );
    } else {
        map.insert(
            CODEX_STATE_DEFAULT_THREAD_ID_KEY.to_string(),
            thread_id_value.clone(),
        );
        map.insert(
            CODEX_STATE_LEGACY_THREAD_ID_KEY.to_string(),
            thread_id_value,
        );
    }

    if let Some(path) = rollout_path {
        let rollout_value = JsonValue::String(path.display().to_string());
        map.insert(
            rollout_path_state_key(mode_key).to_string(),
            rollout_value.clone(),
        );
        if !mode_key.eq_ignore_ascii_case("browser") {
            map.insert(
                CODEX_STATE_LEGACY_ROLLOUT_PATH_KEY.to_string(),
                rollout_value,
            );
        }
    }

    map.insert(
        thread_restore_failed_state_key(mode_key).to_string(),
        JsonValue::Bool(thread_restore_failed),
    );
    map.insert(
        thread_restore_source_state_key(mode_key).to_string(),
        JsonValue::String(thread_restore_source.to_string()),
    );
    map.insert(
        CODEX_STATE_LAST_RESTORE_SOURCE_KEY.to_string(),
        JsonValue::String(thread_restore_source.to_string()),
    );

    let default_failed = map
        .get(CODEX_STATE_DEFAULT_THREAD_RESTORE_FAILED_KEY)
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let browser_failed = map
        .get(CODEX_STATE_BROWSER_THREAD_RESTORE_FAILED_KEY)
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    map.insert(
        CODEX_STATE_HISTORY_REPLAY_REQUIRED_KEY.to_string(),
        JsonValue::Bool(default_failed || browser_failed),
    );

    JsonValue::Object(map)
}

fn latest_completed_agent_message_from_events<'a>(events: &'a [JsonValue]) -> Option<&'a str> {
    events.iter().rev().find_map(|event| {
        let event_type = event.get("type")?.as_str()?;
        if event_type != "item.completed" {
            return None;
        }

        let item = event.get("item")?.as_object()?;
        let item_type = item.get("type")?.as_str()?;
        if item_type != "agent_message" {
            return None;
        }
        if item
            .get("phase")
            .and_then(JsonValue::as_str)
            .is_some_and(|phase| phase == "commentary")
        {
            return None;
        }

        item.get("text")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn latest_completed_agent_commentary_message_from_events<'a>(
    events: &'a [JsonValue],
) -> Option<&'a str> {
    events.iter().rev().find_map(|event| {
        let event_type = event.get("type")?.as_str()?;
        if event_type != "item.completed" {
            return None;
        }

        let item = event.get("item")?.as_object()?;
        let item_type = item.get("type")?.as_str()?;
        if item_type != "agent_message" {
            return None;
        }
        if item
            .get("phase")
            .and_then(JsonValue::as_str)
            .is_none_or(|phase| phase != "commentary")
        {
            return None;
        }

        item.get("text")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn latest_completed_reasoning_message_from_events<'a>(events: &'a [JsonValue]) -> Option<&'a str> {
    events.iter().rev().find_map(|event| {
        let event_type = event.get("type")?.as_str()?;
        if event_type != "item.completed" {
            return None;
        }

        let item = event.get("item")?.as_object()?;
        let item_type = item.get("type")?.as_str()?;
        if item_type != "reasoning" {
            return None;
        }

        item.get("text")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn derive_final_json(
    turn_complete_message: Option<&str>,
    completed_agent_message_item: Option<&str>,
    agent_message_event: Option<&str>,
    commentary_message: Option<&str>,
    reasoning_message: Option<&str>,
    allow_plain_text_fallback: bool,
) -> Result<JsonValue> {
    let parse_candidates = [
        turn_complete_message,
        completed_agent_message_item,
        agent_message_event,
        commentary_message,
    ];

    for candidate in parse_candidates.into_iter().flatten() {
        match parse_codex_final_message(candidate) {
            Ok(value) => return Ok(value),
            Err(err) => {
                tracing::debug!(
                    ?err,
                    candidate_preview = %candidate.chars().take(240).collect::<String>(),
                    "failed to parse candidate Codex assistant message as JSON"
                );
            }
        }
    }

    let Some(fallback_source) = turn_complete_message
        .or(completed_agent_message_item)
        .or(agent_message_event)
    else {
        if let Some(commentary) = commentary_message {
            let preview = commentary.trim().chars().take(500).collect::<String>();
            if allow_plain_text_fallback {
                tracing::warn!(
                    message_preview = %preview,
                    "Codex completed after commentary without a final assistant message; using commentary recovery summary"
                );
                return Ok(json!({
                    "summary": preview,
                    "files": [],
                }));
            }
            tracing::warn!(
                message_preview = %preview,
                "Codex completed after commentary without a final assistant message"
            );
            return Ok(json!({
                "summary": format!(
                    "{COMMENTARY_ONLY_FINAL_ASSISTANT_MESSAGE_SUMMARY_PREFIX}\n\nLast progress output:\n{}",
                    preview
                ),
                "files": [],
            }));
        }
        // Last resort before declaring the turn silent: a completed reasoning
        // item is real progress the user should see. It is intentionally NOT a
        // final-message candidate (and ignores allow_plain_text_fallback) — the
        // commentary-style shape keeps it classified as a missing final so
        // recovery retries still run, just with content instead of silence.
        if let Some(reasoning) = reasoning_message {
            let preview = reasoning.trim().chars().take(500).collect::<String>();
            tracing::warn!(
                message_preview = %preview,
                "Codex completed after reasoning output without a final assistant message"
            );
            return Ok(json!({
                "summary": format!(
                    "{COMMENTARY_ONLY_FINAL_ASSISTANT_MESSAGE_SUMMARY_PREFIX}\n\nLast progress output:\n{}",
                    preview
                ),
                "files": [],
            }));
        }
        tracing::warn!(
            "Codex session completed without a final assistant message; using empty fallback summary"
        );
        return Ok(json!({
            "summary": MISSING_FINAL_ASSISTANT_MESSAGE_SUMMARY,
            "files": [],
        }));
    };
    let preview = fallback_source.trim().chars().take(500).collect::<String>();
    if allow_plain_text_fallback {
        tracing::warn!(
            message_preview = %preview,
            "failed to parse Codex final assistant message as JSON; using plain text recovery summary"
        );
        return Ok(json!({
            "summary": preview,
            "files": [],
        }));
    }
    tracing::warn!(
        message_preview = %preview,
        "failed to parse Codex final assistant message as JSON; using text fallback summary"
    );
    Ok(json!({
        "summary": format!(
            "{INVALID_FINAL_ASSISTANT_MESSAGE_JSON_SUMMARY_PREFIX}\n\nRaw assistant output:\n{}",
            preview
        ),
        "files": [],
    }))
}

fn parse_codex_final_message(raw: &str) -> Result<JsonValue> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Codex final assistant message is empty"));
    }

    if let Ok(value) = serde_json::from_str::<JsonValue>(trimmed) {
        return Ok(normalize_codex_final_json_value(value));
    }

    if let Some(block) = extract_markdown_fenced_block(trimmed) {
        let candidate = block.trim();
        if let Ok(value) = serde_json::from_str::<JsonValue>(candidate) {
            return Ok(normalize_codex_final_json_value(value));
        }
        if let Some(repaired) = repair_escaped_json_quotes(candidate) {
            if let Ok(value) = serde_json::from_str::<JsonValue>(&repaired) {
                return Ok(normalize_codex_final_json_value(value));
            }
        }
        if let Some(repaired) = escape_json_control_chars_in_strings(candidate) {
            if let Ok(value) = serde_json::from_str::<JsonValue>(&repaired) {
                return Ok(normalize_codex_final_json_value(value));
            }
        }
    }

    if let Some(start) = trimmed.find('{').or_else(|| trimmed.find('[')) {
        let candidate = &trimmed[start..];
        if let Ok(value) = parse_json_stream(candidate) {
            return Ok(normalize_codex_final_json_value(value));
        }
        if let Some(repaired) = repair_escaped_json_quotes(candidate) {
            if let Ok(value) = parse_json_stream(&repaired) {
                return Ok(normalize_codex_final_json_value(value));
            }
        }
        if let Some(repaired) = escape_json_control_chars_in_strings(candidate) {
            if let Ok(value) = parse_json_stream(&repaired) {
                return Ok(normalize_codex_final_json_value(value));
            }
        }
    }

    if let Some(repaired) = repair_escaped_json_quotes(trimmed) {
        if let Ok(value) = serde_json::from_str::<JsonValue>(&repaired) {
            return Ok(normalize_codex_final_json_value(value));
        }
    }

    if let Some(repaired) = escape_json_control_chars_in_strings(trimmed) {
        if let Ok(value) = serde_json::from_str::<JsonValue>(&repaired) {
            return Ok(normalize_codex_final_json_value(value));
        }
    }

    serde_json::from_str(trimmed).context("invalid JSON")
}

fn normalize_codex_final_json_value(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(_) => value,
        JsonValue::String(summary) => json!({ "summary": summary, "files": [] }),
        JsonValue::Number(number) => {
            json!({ "summary": number.to_string(), "files": [] })
        }
        JsonValue::Bool(value) => json!({ "summary": value.to_string(), "files": [] }),
        JsonValue::Null => json!({ "summary": "null", "files": [] }),
        other => json!({ "summary": other.to_string(), "files": [] }),
    }
}

fn extract_markdown_fenced_block(input: &str) -> Option<&str> {
    let trimmed = input.trim();
    if !trimmed.starts_with("```") {
        return None;
    }

    let first_newline = trimmed.find('\n')?;
    let content_start = first_newline + 1;
    let closing = trimmed[content_start..].rfind("```")? + content_start;
    if closing <= content_start {
        return None;
    }
    Some(&trimmed[content_start..closing])
}

fn parse_json_stream(input: &str) -> Result<JsonValue> {
    let mut deserializer = serde_json::Deserializer::from_str(input);
    JsonValue::deserialize(&mut deserializer).context("invalid JSON")
}

fn apply_runtime_proxy_model_provider_overrides(config: &mut Config) {
    let Some(openai_base_url) = optional_env("OPENAI_BASE_URL")
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    config.model_provider.base_url = Some(openai_base_url.clone());
    // The local proxy currently exposes HTTP/SSE Responses endpoints, not the new
    // Responses websocket transport. Keep runtime automation on the proxy.
    config.model_provider.supports_websockets = false;
    if let Some(provider) = config.model_providers.get_mut(&config.model_provider_id) {
        provider.base_url = Some(openai_base_url.clone());
        provider.supports_websockets = false;
    }

    if let Some(chatgpt_base_url) = runtime_chatgpt_base_url_from_env() {
        config.chatgpt_base_url = chatgpt_base_url;
    }

    tracing::info!(
        model_provider_id = %config.model_provider_id,
        openai_base_url = %openai_base_url,
        supports_websockets = config.model_provider.supports_websockets,
        "applied runtime proxy model provider overrides"
    );
}

fn runtime_chatgpt_base_url_from_env() -> Option<String> {
    optional_env("PROXY_BASE_URL")
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .map(|base| format!("{base}/backend-api/"))
}

fn personal_browser_capability_is_present() -> bool {
    crate::personal_browser::process_capability_is_present()
}

fn scope_runtime_model_shell_environment(policy: &mut ShellEnvironmentPolicy) {
    // `exclude` is applied before `set`, so also remove any configured override for a machine
    // credential. This policy is unconditional: read-only and path-scoped jobs still have a full
    // shell tool and must receive only their verified per-job CONTROLLER_ACCESS_TOKEN.
    policy
        .r#set
        .retain(|key, _| !is_model_child_excluded_env_key(key));
    for key in INTERNAL_CREDENTIAL_ENV_KEYS
        .iter()
        .chain(MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS)
    {
        policy
            .exclude
            .push(EnvironmentVariablePattern::new_case_insensitive(key));
    }
}

fn shared_browser_capability_is_present() -> bool {
    optional_env(SHARED_BROWSER_SESSION_ENV)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn scope_browser_capabilities_from_shell_environment(policy: &mut ShellEnvironmentPolicy) {
    for key in [
        PERSONAL_BROWSER_CONTROL_URL_ENV,
        PERSONAL_BROWSER_CONTROL_TOKEN_ENV,
        PERSONAL_BROWSER_PROJECT_ID_ENV,
        RUNTIME_AGENT_BIN_ENV,
        SHARED_BROWSER_SESSION_ENV,
        SHARED_BROWSER_ACTIONS_FILE_ENV,
        SHARED_BROWSER_AGENT_CONTROL_FILE_ENV,
        SHARED_BROWSER_APPROVAL_DIR_ENV,
        SHARED_BROWSER_APPROVAL_TIMEOUT_MS_ENV,
        SHARED_BROWSER_CDP_PORT_ENV,
        SHARED_BROWSER_CDP_URL_ENV,
        SHARED_BROWSER_PAGE_ID_ENV,
        SHARED_BROWSER_PLAYWRIGHT_MODULE_PATH_ENV,
        SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT_ENV,
    ] {
        policy.r#set.remove(key);
        policy
            .exclude
            .push(EnvironmentVariablePattern::new_case_insensitive(key));
    }
}

fn install_browser_mcp_servers(
    config: &mut Config,
    personal_enabled: bool,
    shared_enabled: bool,
    shared_page_id: Option<&str>,
) -> Result<()> {
    if personal_enabled && shared_enabled {
        return Err(anyhow!(
            "Personal Browser and Shared Browser cannot be enabled in the same Codex turn"
        ));
    }

    // A browser capability must never coexist with project-configured MCP servers. A hostile
    // server can request selected parent environment variables or attach headers sourced from
    // them. Replacing the map keeps the Personal bearer and Shared CDP capability reachable only
    // through the single trusted broker for this turn.
    let mut servers = if personal_enabled || shared_enabled {
        HashMap::new()
    } else {
        (*config.mcp_servers).clone()
    };
    servers.remove(PERSONAL_BROWSER_MCP_SERVER_NAME);
    servers.remove(SHARED_BROWSER_MCP_SERVER_NAME);

    if personal_enabled {
        let (url, project_id, token) = crate::personal_browser::mcp_registration_from_process()
            .context("failed to prepare Personal Browser MCP registration")?;
        servers.insert(
            PERSONAL_BROWSER_MCP_SERVER_NAME.to_string(),
            browser_mcp_server_config(McpServerTransportConfig::StreamableHttp {
                url,
                bearer_token_env_var: None,
                http_headers: Some(HashMap::from([
                    ("authorization".to_string(), format!("Bearer {token}")),
                    ("x-instafy-project-id".to_string(), project_id),
                ])),
                env_http_headers: None,
            }),
        );
    }

    if shared_enabled {
        let page_id = crate::shared_browser::validate_page_id(
            shared_page_id
                .context("Shared Browser MCP requires the job's UI-selected browserPageId")?,
        )?;
        let executable = std::env::current_exe()
            .context("failed to locate runtime-agent for Shared Browser MCP")?;
        let trusted_cwd = executable
            .parent()
            .context("runtime-agent executable has no trusted parent directory")?
            .to_path_buf();
        let mut environment =
            HashMap::from([(SHARED_BROWSER_SESSION_ENV.to_string(), "1".to_string())]);
        environment.insert(SHARED_BROWSER_PAGE_ID_ENV.to_string(), page_id);
        for key in [
            SHARED_BROWSER_ACTIONS_FILE_ENV,
            SHARED_BROWSER_AGENT_CONTROL_FILE_ENV,
            SHARED_BROWSER_APPROVAL_DIR_ENV,
            SHARED_BROWSER_APPROVAL_TIMEOUT_MS_ENV,
            SHARED_BROWSER_CDP_PORT_ENV,
            SHARED_BROWSER_CDP_URL_ENV,
            SHARED_BROWSER_PLAYWRIGHT_MODULE_PATH_ENV,
            SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT_ENV,
        ] {
            if let Some(value) = optional_env(key) {
                environment.insert(key.to_string(), value);
            }
        }
        for key in [
            SHARED_BROWSER_PLAYWRIGHT_MODULE_PATH_ENV,
            SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT_ENV,
        ] {
            let value = environment.get(key).with_context(|| {
                format!("Shared Browser trusted runtime environment is missing {key}")
            })?;
            if !Path::new(value).is_absolute() {
                return Err(anyhow!(
                    "Shared Browser trusted runtime environment {key} must be an absolute path"
                ));
            }
        }
        servers.insert(
            SHARED_BROWSER_MCP_SERVER_NAME.to_string(),
            browser_mcp_server_config(McpServerTransportConfig::Stdio {
                command: executable.to_string_lossy().into_owned(),
                args: vec![SHARED_BROWSER_MCP_COMMAND.to_string()],
                env: Some(environment),
                env_vars: Vec::new(),
                cwd: Some(LegacyAppPathString::from_path(&trusted_cwd)),
            }),
        );
    }

    if personal_enabled || shared_enabled {
        let expected_server_name = if personal_enabled {
            PERSONAL_BROWSER_MCP_SERVER_NAME
        } else {
            SHARED_BROWSER_MCP_SERVER_NAME
        };
        validate_bounded_browser_mcp_server_set(&servers, expected_server_name)?;
    }

    config
        .mcp_servers
        .set(servers)
        .context("failed to install the bounded browser MCP server set")?;
    Ok(())
}

fn browser_mcp_server_config(transport: McpServerTransportConfig) -> McpServerConfig {
    McpServerConfig {
        transport,
        auth: Default::default(),
        environment_id: DEFAULT_MCP_SERVER_ENVIRONMENT_ID.to_string(),
        enabled: true,
        required: true,
        supports_parallel_tool_calls: false,
        disabled_reason: None,
        startup_timeout_sec: Some(Duration::from_secs(10)),
        tool_timeout_sec: Some(Duration::from_secs(40)),
        default_tools_approval_mode: None,
        enabled_tools: Some(browser_mcp_enabled_tools()),
        disabled_tools: None,
        scopes: None,
        oauth: None,
        oauth_resource: None,
        tools: HashMap::new(),
    }
}

fn browser_mcp_enabled_tools() -> Vec<String> {
    BROWSER_MCP_TOOL_NAMES
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn validate_bounded_browser_mcp_server_set(
    servers: &HashMap<String, McpServerConfig>,
    expected_server_name: &str,
) -> Result<()> {
    if servers.len() != 1 {
        return Err(anyhow!(
            "bounded browser turn must offer exactly one MCP server"
        ));
    }
    let server = servers.get(expected_server_name).with_context(|| {
        format!("bounded browser turn is missing required MCP server {expected_server_name}")
    })?;
    if !server.enabled || !server.required || server.supports_parallel_tool_calls {
        return Err(anyhow!(
            "bounded browser MCP server must be enabled, required, and serial"
        ));
    }
    if server.enabled_tools.as_ref() != Some(&browser_mcp_enabled_tools()) {
        return Err(anyhow!(
            "bounded browser MCP server does not match the exact browser tool allowlist"
        ));
    }
    if server.disabled_tools.is_some() {
        return Err(anyhow!(
            "bounded browser MCP server must not carry an additional disabled-tool policy"
        ));
    }
    Ok(())
}

/// Return the capability contract compiled into this exact runtime-agent binary.
///
/// The packaged Desktop release canary invokes this command before importing a
/// local Codex credential. The same constants, config constructor, validator,
/// and environment-selection path are used by real bounded browser turns, so a
/// package cannot advertise a broader tool set without also changing the
/// production configuration checked on every Personal Browser launch.
pub fn personal_browser_capability_contract() -> Result<JsonValue> {
    let server = browser_mcp_server_config(McpServerTransportConfig::StreamableHttp {
        url: "http://127.0.0.1/contract-only".to_string(),
        bearer_token_env_var: None,
        http_headers: None,
        env_http_headers: None,
    });
    let servers = HashMap::from([(PERSONAL_BROWSER_MCP_SERVER_NAME.to_string(), server)]);
    validate_bounded_browser_mcp_server_set(&servers, PERSONAL_BROWSER_MCP_SERVER_NAME)?;

    let cwd = AbsolutePathBuf::current_dir()
        .context("failed to resolve cwd for Personal Browser capability contract")?;
    let environment_count = turn_environment_selections(cwd, true).environments.len();
    if environment_count != 0 {
        return Err(anyhow!(
            "bounded Personal Browser contract unexpectedly exposes a local execution environment"
        ));
    }

    Ok(json!({
        "schemaVersion": 1,
        "browserTransport": "desktop-personal",
        "mcpServers": [{
            "name": PERSONAL_BROWSER_MCP_SERVER_NAME,
            "required": true,
            "supportsParallelToolCalls": false,
            "enabledTools": BROWSER_MCP_TOOL_NAMES,
        }],
        "projectMcpServersAllowed": false,
        "localExecutionEnvironmentCount": environment_count,
    }))
}

fn should_refresh_mcp_servers(
    mcp_mode: bool,
    personal_browser_mode: bool,
    has_mcp_servers: bool,
) -> bool {
    // The Personal bearer lives only in its trusted process capability and an
    // ephemeral in-memory transport header. Personal turns use fresh Codex
    // threads, so serializing that config into RefreshMcpServers would only
    // widen the secret's lifetime without providing continuity.
    mcp_mode && has_mcp_servers && !personal_browser_mode
}

fn append_shared_browser_developer_instructions(base: String, enabled: bool) -> String {
    if !enabled {
        return base;
    }
    format!("{base}\n\n{SHARED_BROWSER_DEVELOPER_INSTRUCTIONS}")
}

fn append_personal_browser_developer_instructions(base: String, enabled: bool) -> String {
    if !enabled {
        return base;
    }
    format!("{base}\n\n{PERSONAL_BROWSER_DEVELOPER_INSTRUCTIONS}")
}

fn apply_runtime_security_feature_overrides(features: &mut ManagedFeatures) {
    // Shell snapshots replay all exported env vars into files under CODEX_HOME. Runtime jobs carry
    // proxy and controller tokens in env today, so embedded runtime-agent runs must keep this off.
    if features.enabled(Feature::ShellSnapshot) {
        match features.disable(Feature::ShellSnapshot) {
            Ok(()) => tracing::info!("disabled Codex shell snapshots for runtime-agent run"),
            Err(error) => tracing::warn!(
                error = %error,
                "failed to disable Codex shell snapshots for runtime-agent run"
            ),
        }
    }
    if features.enabled(Feature::Personality) {
        match features.disable(Feature::Personality) {
            Ok(()) => tracing::info!("disabled Codex personality feature for runtime-agent run"),
            Err(error) => tracing::warn!(
                error = %error,
                "failed to disable Codex personality feature for runtime-agent run"
            ),
        }
    }
}

fn apply_bounded_browser_security_overrides(config: &mut Config, enabled: bool) -> Result<()> {
    if !enabled {
        return Ok(());
    }

    disable_bounded_browser_features(&mut config.features)?;
    config
        .web_search_mode
        .set(WebSearchMode::Disabled)
        .context("failed to disable web search for bounded browser turn")?;
    config.experimental_request_user_input_enabled = false;
    config.include_skill_instructions = false;
    config.include_apps_instructions = false;
    Ok(())
}

fn disable_bounded_browser_features(features: &mut ManagedFeatures) -> Result<()> {
    // These turns are a single browser capability lane. Page content is
    // untrusted, so it must not be able to reach local files, child agents,
    // another network tool, plugins, or image generation through prompt
    // injection.
    for feature in bounded_browser_disabled_features() {
        features
            .disable(feature)
            .with_context(|| format!("failed to disable {feature:?} for bounded browser turn"))?;
        if features.enabled(feature) {
            return Err(anyhow!(
                "bounded browser turn cannot start while {feature:?} is pinned enabled"
            ));
        }
    }
    Ok(())
}

fn bounded_browser_disabled_features() -> impl Iterator<Item = Feature> {
    [
        Feature::ShellTool,
        Feature::UnifiedExec,
        Feature::ShellZshFork,
        Feature::UnifiedExecZshFork,
        Feature::ExecPermissionApprovals,
        Feature::ApplyPatchStreamingEvents,
        Feature::CodeModeOnly,
        Feature::CodeMode,
        Feature::CodeModeBufferedExec,
        Feature::CodeModeHost,
        Feature::SpawnCsv,
        Feature::MultiAgentV2,
        Feature::Collab,
        Feature::CollaborationModes,
        Feature::StandaloneWebSearch,
        Feature::WebSearchCached,
        Feature::WebSearchRequest,
        Feature::ImageGeneration,
        Feature::ToolSuggest,
        Feature::Apps,
        Feature::Plugins,
        Feature::RequestPermissionsTool,
        Feature::MemoryTool,
        Feature::ExternalAgentMemoryImport,
        Feature::Chronicle,
        Feature::CodexHooks,
        Feature::SkillMcpDependencyInstall,
        Feature::ExecutorCapabilityDiscovery,
        Feature::EnableMcpApps,
        Feature::BrowserUse,
        Feature::BrowserUseFullCdpAccess,
        Feature::BrowserUseExternal,
        Feature::ComputerUse,
        Feature::RemotePlugin,
        Feature::PluginSharing,
        Feature::DefaultModeRequestUserInput,
        Feature::Goals,
        Feature::Artifact,
        Feature::WorkspaceDependencies,
        Feature::ToolCallMcpElicitation,
        Feature::AuthElicitation,
    ]
    .into_iter()
}

fn turn_environment_selections(
    default_cwd: AbsolutePathBuf,
    bounded_browser_mode: bool,
) -> TurnEnvironmentSelections {
    let environments = if bounded_browser_mode {
        Vec::new()
    } else {
        vec![TurnEnvironmentSelection {
            environment_id: LOCAL_ENVIRONMENT_ID.to_string(),
            cwd: PathUri::from_abs_path(&default_cwd),
            workspace_roots: vec![PathUri::from_abs_path(&default_cwd)],
        }]
    };
    TurnEnvironmentSelections::new(default_cwd, environments)
}

fn clamp_runtime_reasoning_effort(config: &mut Config) {
    let target = optional_env("CODEX_RUNTIME_REASONING_EFFORT")
        .and_then(|value| value.parse::<ReasoningEffort>().ok())
        .unwrap_or(ReasoningEffort::Low);

    if config.model_reasoning_effort.as_ref() != Some(&target) {
        tracing::info!(
            from = ?config.model_reasoning_effort,
            to = ?target,
            "clamped Codex reasoning effort for runtime-agent background run"
        );
        config.model_reasoning_effort = Some(target);
    }
}

/// Parse the per-agent reasoning effort the controller emits as
/// `CODEX_AGENT_REASONING_EFFORT`. Only the four supported values
/// (minimal|low|medium|high, case-insensitive) are honored, mapping to the real
/// `ReasoningEffort` variants; anything else (including unset/empty) yields None
/// so callers fall back to the existing per-job / global reasoning behavior.
/// Note: we intentionally match explicitly rather than `str::parse::<ReasoningEffort>()`,
/// whose FromStr is case-sensitive and coerces unknown strings into a Custom variant.
fn agent_reasoning_effort_override() -> Option<ReasoningEffort> {
    let raw = optional_env("CODEX_AGENT_REASONING_EFFORT")?;
    match raw.to_ascii_lowercase().as_str() {
        "minimal" => Some(ReasoningEffort::Minimal),
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        _ => None,
    }
}

fn cleanup_workspace_local_shell_snapshots(workspace_dir: &Path) {
    let mut codex_homes = HashSet::from([
        workspace_dir.join(".codex"),
        workspace_dir.join(".codex-runtime-fallback"),
    ]);
    // Hosted runtimes commonly share CODEX_HOME at /workspace/.codex while a project lives at
    // /workspace/<project>. Remove stale snapshots from that resolved home as well.
    codex_homes.insert(resolve_codex_home(workspace_dir));

    for codex_home in codex_homes {
        let snapshot_dir = codex_home.join("shell_snapshots");
        if !snapshot_dir.is_dir() {
            continue;
        }
        match fs::remove_dir_all(&snapshot_dir) {
            Ok(()) => tracing::info!(
                snapshot_dir = %snapshot_dir.display(),
                "removed runtime Codex shell snapshots"
            ),
            Err(error) => tracing::warn!(
                snapshot_dir = %snapshot_dir.display(),
                error = %error,
                "failed to remove runtime Codex shell snapshots"
            ),
        }
    }
}

fn repair_escaped_json_quotes(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if !(trimmed.starts_with("{\\\"") || trimmed.starts_with("[\\\"")) {
        return None;
    }

    // Some model providers emit JSON with all structural quotes escaped (e.g. `{\"summary\":...}`),
    // which is not valid JSON. Recover by removing one level of escaping for `"` while leaving
    // other escape sequences (like `\n`) untouched.
    let bytes = trimmed.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut idx = 0usize;

    while idx < bytes.len() {
        if bytes[idx] != b'\\' {
            out.push(bytes[idx]);
            idx += 1;
            continue;
        }

        let start = idx;
        while idx < bytes.len() && bytes[idx] == b'\\' {
            idx += 1;
        }

        if idx < bytes.len() && bytes[idx] == b'"' {
            let backslashes = idx - start;
            if backslashes > 1 {
                out.extend(std::iter::repeat(b'\\').take(backslashes - 1));
            }
            out.push(b'"');
            idx += 1;
            continue;
        }

        out.extend_from_slice(&bytes[start..idx]);
    }

    Some(String::from_utf8_lossy(&out).to_string())
}

fn escape_json_control_chars_in_strings(input: &str) -> Option<String> {
    let mut out = String::with_capacity(input.len());
    let mut changed = false;
    let mut in_string = false;
    let mut escape = false;

    for ch in input.chars() {
        if !in_string {
            out.push(ch);
            if ch == '"' {
                in_string = true;
                escape = false;
            }
            continue;
        }

        if escape {
            out.push(ch);
            escape = false;
            continue;
        }

        match ch {
            '\\' => {
                out.push(ch);
                escape = true;
            }
            '"' => {
                out.push(ch);
                in_string = false;
            }
            '\n' => {
                out.push_str("\\n");
                changed = true;
            }
            '\r' => {
                out.push_str("\\r");
                changed = true;
            }
            '\t' => {
                out.push_str("\\t");
                changed = true;
            }
            other if (other as u32) < 0x20 => {
                let _ =
                    std::fmt::Write::write_fmt(&mut out, format_args!("\\u{:04X}", other as u32));
                changed = true;
            }
            other => out.push(other),
        }
    }

    if changed { Some(out) } else { None }
}

#[derive(Debug, Clone, Default)]
struct CommandExecutionState {
    command: String,
    aggregated_output: String,
}

#[derive(Debug, Default)]
struct CodexEventStreamAdapter {
    command_states: HashMap<String, CommandExecutionState>,
    patch_apply_paths: HashMap<String, Vec<String>>,
    agent_message_delta_buffers: HashMap<String, String>,
    last_agent_message_delta_id: Option<String>,
    completed_agent_message_seen: bool,
    last_total_token_usage: Option<JsonValue>,
}

impl CodexEventStreamAdapter {
    fn collect(&mut self, event: &Event) -> Vec<JsonValue> {
        match &event.msg {
            EventMsg::AgentMessage(message) => {
                let Some(text) = trimmed_text(&message.message) else {
                    return Vec::new();
                };
                self.completed_agent_message_seen = true;
                let mut value = json!({
                    "type": "item.completed",
                    "item": {
                        "id": event.id,
                        "type": "agent_message",
                        "text": text,
                    }
                });
                if let Some(phase) = message_phase_label(message.phase.as_ref()) {
                    value["item"]["phase"] = json!(phase);
                }
                vec![value]
            }
            EventMsg::AgentMessageContentDelta(delta) => {
                self.collect_agent_message_delta(delta.item_id.clone(), &delta.delta)
            }
            EventMsg::ItemCompleted(item_completed) => {
                self.collect_completed_turn_item(&item_completed.item)
            }
            EventMsg::RawResponseItem(raw) => self.collect_raw_response_item(&raw.item),
            EventMsg::AgentReasoning(reasoning) => vec![json!({
                "type": "item.completed",
                "item": {
                    "id": event.id,
                    "type": "reasoning",
                    "text": reasoning.text,
                    "status": "completed",
                }
            })],
            EventMsg::ReasoningContentDelta(reasoning) => vec![json!({
                "type": "item.updated",
                "item": {
                    "id": reasoning.item_id,
                    "type": "reasoning",
                    "text": reasoning.delta,
                    "status": "in_progress",
                }
            })],
            EventMsg::ExecCommandBegin(command) => {
                let command_text = shell_join(&command.command);
                self.command_states.insert(
                    command.call_id.clone(),
                    CommandExecutionState {
                        command: command_text.clone(),
                        aggregated_output: String::new(),
                    },
                );
                vec![json!({
                    "type": "item.started",
                    "item": {
                        "id": command.call_id,
                        "type": "command_execution",
                        "command": command_text,
                        "status": "in_progress",
                        "aggregated_output": "",
                        "exit_code": JsonValue::Null,
                    }
                })]
            }
            EventMsg::ExecCommandOutputDelta(delta) => {
                let Some(state) = self.command_states.get_mut(&delta.call_id) else {
                    return Vec::new();
                };
                append_capped_command_output(&mut state.aggregated_output, &delta.chunk);
                Vec::new()
            }
            EventMsg::ExecCommandEnd(command) => {
                let state = self.command_states.remove(&command.call_id);
                let command_text = state
                    .as_ref()
                    .map(|state| state.command.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| shell_join(&command.command));
                let output_text = state
                    .as_ref()
                    .map(|state| state.aggregated_output.as_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or(command.aggregated_output.as_str());
                let aggregated_output = compact_command_output_for_event(output_text);
                let status = match command.status {
                    codex_protocol::protocol::ExecCommandStatus::Completed => "completed",
                    codex_protocol::protocol::ExecCommandStatus::Failed => "failed",
                    codex_protocol::protocol::ExecCommandStatus::Declined => "declined",
                };
                vec![json!({
                    "type": "item.completed",
                    "item": {
                        "id": command.call_id,
                        "type": "command_execution",
                        "command": command_text,
                        "status": status,
                        "aggregated_output": aggregated_output,
                        "exit_code": command.exit_code,
                    }
                })]
            }
            EventMsg::McpToolCallBegin(tool_call) => vec![json!({
                "type": "item.started",
                "item": {
                    "id": tool_call.call_id,
                    "type": "mcp_tool_call",
                    "server": tool_call.invocation.server,
                    "tool": tool_call.invocation.tool,
                    "status": "in_progress",
                }
            })],
            EventMsg::McpToolCallEnd(tool_call) => {
                let terminal_consent = if tool_call
                    .invocation
                    .server
                    .eq_ignore_ascii_case(SHARED_BROWSER_MCP_SERVER_NAME)
                {
                    tool_call
                        .result
                        .as_ref()
                        .ok()
                        .and_then(|result| result.structured_content.as_ref())
                        .and_then(|payload| payload.get("terminalConsent"))
                        .and_then(|signal| {
                            let code = signal.get("code").and_then(JsonValue::as_str)?;
                            (signal.get("terminal").and_then(JsonValue::as_bool) == Some(true)
                                && signal.get("retryable").and_then(JsonValue::as_bool)
                                    == Some(false)
                                && crate::shared_browser::canonical_terminal_consent_failure_code(
                                    code,
                                )
                                .is_some())
                            .then(|| signal.clone())
                        })
                } else {
                    None
                };
                let mut item = json!({
                    "id": tool_call.call_id,
                    "type": "mcp_tool_call",
                    "server": tool_call.invocation.server,
                    "tool": tool_call.invocation.tool,
                    "status": if tool_call.is_success() { "completed" } else { "failed" },
                });
                if let Some(terminal_consent) = terminal_consent {
                    item["terminalConsent"] = terminal_consent;
                }
                vec![json!({
                    "type": "item.completed",
                    "item": item,
                })]
            }
            EventMsg::TokenCount(token_count) => {
                self.last_total_token_usage = token_count
                    .info
                    .as_ref()
                    .and_then(|info| serde_json::to_value(&info.total_token_usage).ok());
                Vec::new()
            }
            EventMsg::TurnComplete(_) => {
                let mut events = Vec::new();
                if let Some(completed_message) = self.completed_agent_message_from_deltas() {
                    events.push(completed_message);
                }
                if let Some(usage) = self.last_total_token_usage.clone() {
                    events.push(json!({
                        "type": "turn.completed",
                        "usage": usage,
                    }));
                }
                events
            }
            EventMsg::Warning(warning) | EventMsg::GuardianWarning(warning) => vec![json!({
                "type": "item.completed",
                "item": {
                    "id": event.id,
                    "type": "agent_message",
                    "text": warning.message,
                }
            })],
            EventMsg::ModelReroute(model_reroute) => {
                let message = match model_reroute.reason {
                    codex_protocol::protocol::ModelRerouteReason::HighRiskCyberActivity => format!(
                        "Your account was flagged for potentially high-risk cyber activity and this request was routed to {} as a fallback. To regain access to {}, apply for trusted access: https://chatgpt.com/cyber",
                        model_reroute.to_model, model_reroute.from_model
                    ),
                };
                vec![json!({
                    "type": "item.completed",
                    "item": {
                        "id": event.id,
                        "type": "agent_message",
                        "text": message,
                    }
                })]
            }
            EventMsg::PatchApplyBegin(patch) => {
                let mut paths: Vec<String> = patch
                    .changes
                    .keys()
                    .map(|path| path.display().to_string())
                    .collect();
                paths.sort();
                self.patch_apply_paths
                    .insert(patch.call_id.clone(), paths.clone());
                vec![json!({
                    "type": "item.started",
                    "item": {
                        "id": patch.call_id,
                        "type": "file_change",
                        "paths": paths,
                        "auto_approved": patch.auto_approved,
                        "status": "in_progress",
                    }
                })]
            }
            EventMsg::PatchApplyEnd(patch) => {
                let paths = self
                    .patch_apply_paths
                    .remove(&patch.call_id)
                    .unwrap_or_default();
                let mut value = json!({
                    "type": "item.completed",
                    "item": {
                        "id": patch.call_id,
                        "type": "file_change",
                        "paths": paths,
                        "status": if patch.success { "completed" } else { "failed" },
                    }
                });
                if !patch.success {
                    let stderr = patch.stderr.trim();
                    if !stderr.is_empty() {
                        value["item"]["stderr"] = json!(compact_command_output_for_event(stderr));
                    }
                }
                vec![value]
            }
            EventMsg::TurnDiff(diff) => vec![json!({
                "type": "item.completed",
                "item": {
                    "id": event.id,
                    "type": "turn_diff",
                    "unified_diff": diff.unified_diff,
                    "status": "completed",
                }
            })],
            EventMsg::TurnAborted(aborted) => vec![json!({
                "type": "error",
                "message": format!(
                    "Turn aborted ({})",
                    serde_json::to_string(&aborted.reason)
                        .unwrap_or_else(|_| "unknown".to_string())
                        .trim_matches('"')
                ),
            })],
            EventMsg::Error(error) => vec![json!({
                "type": "error",
                "message": error.message,
            })],
            EventMsg::StreamError(error) => vec![json!({
                "type": "error",
                "message": error.additional_details.as_deref().unwrap_or(&error.message),
            })],
            _ => Vec::new(),
        }
    }

    fn collect_agent_message_delta(&mut self, id: String, delta: &str) -> Vec<JsonValue> {
        if delta.is_empty() {
            return Vec::new();
        }

        let text = self
            .agent_message_delta_buffers
            .entry(id.clone())
            .or_default();
        text.push_str(delta);
        self.last_agent_message_delta_id = Some(id.clone());
        vec![json!({
            "type": "item.updated",
            "item": {
                "id": id,
                "type": "agent_message",
                "text": text,
                "status": "in_progress",
            }
        })]
    }

    fn collect_completed_turn_item(&mut self, item: &TurnItem) -> Vec<JsonValue> {
        let TurnItem::AgentMessage(message) = item else {
            return Vec::new();
        };
        let Some(text) = agent_message_text(message) else {
            return Vec::new();
        };
        self.completed_agent_message_seen = true;
        let mut value = json!({
            "type": "item.completed",
            "item": {
                "id": message.id.clone(),
                "type": "agent_message",
                "text": text,
            }
        });
        if let Some(phase) = message_phase_label(message.phase.as_ref()) {
            value["item"]["phase"] = json!(phase);
        }
        vec![value]
    }

    fn collect_raw_response_item(&mut self, item: &ResponseItem) -> Vec<JsonValue> {
        let Some(text) = assistant_response_item_text(item) else {
            return Vec::new();
        };
        self.completed_agent_message_seen = true;
        vec![json!({
            "type": "item.completed",
            "item": {
                "id": "raw_response_item",
                "type": "agent_message",
                "text": text,
            }
        })]
    }

    fn completed_agent_message_from_deltas(&mut self) -> Option<JsonValue> {
        if self.completed_agent_message_seen {
            return None;
        }
        let id = self.last_agent_message_delta_id.clone()?;
        let text = self
            .agent_message_delta_buffers
            .get(&id)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())?
            .to_string();
        self.completed_agent_message_seen = true;
        Some(json!({
            "type": "item.completed",
            "item": {
                "id": id,
                "type": "agent_message",
                "text": text,
            }
        }))
    }
}

fn append_capped_command_output(buffer: &mut String, chunk: &[u8]) {
    buffer.push_str(&String::from_utf8_lossy(chunk));
    if buffer.chars().count() <= MAX_COMMAND_OUTPUT_BUFFER_CHARS {
        return;
    }

    let tail = tail_chars(buffer, MAX_COMMAND_OUTPUT_BUFFER_CHARS);
    buffer.clear();
    buffer.push_str("[command output truncated; keeping tail]\n");
    buffer.push_str(&tail);
}

fn compact_command_output_for_event(output: &str) -> String {
    if output_mentions_shell_snapshot(output) {
        return "[runtime-local shell snapshot output omitted]".to_string();
    }
    if output.chars().count() <= MAX_COMMAND_OUTPUT_EVENT_CHARS {
        return output.to_string();
    }
    format!(
        "[command output truncated; keeping tail]\n{}",
        tail_chars(output, MAX_COMMAND_OUTPUT_EVENT_CHARS)
    )
}

fn output_mentions_shell_snapshot(output: &str) -> bool {
    output.contains(".codex-runtime-fallback/shell_snapshots")
        || output.contains(".codex/shell_snapshots")
        || output.contains("shell_snapshots/")
}

fn tail_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars().rev().take(max_chars).collect::<Vec<_>>();
    chars.reverse();
    chars.into_iter().collect()
}

fn assistant_response_item_text(item: &ResponseItem) -> Option<String> {
    let ResponseItem::Message {
        role,
        content,
        phase,
        ..
    } = item
    else {
        return None;
    };
    if role != "assistant" || matches!(phase, Some(MessagePhase::Commentary)) {
        return None;
    }
    let text = content
        .iter()
        .filter_map(|entry| match entry {
            ContentItem::OutputText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn message_phase_label(phase: Option<&MessagePhase>) -> Option<&'static str> {
    match phase {
        Some(MessagePhase::Commentary) => Some("commentary"),
        Some(MessagePhase::FinalAnswer) => Some("final_answer"),
        None => None,
    }
}

fn is_commentary_phase(phase: Option<&MessagePhase>) -> bool {
    matches!(phase, Some(MessagePhase::Commentary))
}

fn is_unstructured_turn_complete_candidate(
    requires_structured_final: bool,
    non_commentary_agent_message_seen: bool,
    text: &str,
) -> bool {
    requires_structured_final
        && !non_commentary_agent_message_seen
        && parse_codex_final_message(text).is_err()
}

fn trimmed_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn agent_message_event_text(
    message: &codex_protocol::protocol::AgentMessageEvent,
) -> Option<String> {
    if is_commentary_phase(message.phase.as_ref()) {
        return None;
    }
    trimmed_text(&message.message)
}

fn agent_message_text(message: &codex_protocol::items::AgentMessageItem) -> Option<String> {
    let text = message
        .content
        .iter()
        .map(|entry| match entry {
            AgentMessageContent::Text { text } => text.as_str(),
        })
        .collect::<String>();
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn final_agent_message_text(message: &codex_protocol::items::AgentMessageItem) -> Option<String> {
    if is_commentary_phase(message.phase.as_ref()) {
        return None;
    }
    agent_message_text(message)
}

fn final_agent_message_text_from_turn_item(item: &TurnItem) -> Option<String> {
    match item {
        TurnItem::AgentMessage(message) => final_agent_message_text(message),
        _ => None,
    }
}

fn collect_events(
    aggregator: &mut CodexEventStreamAdapter,
    event: &Event,
    out: &mut Vec<JsonValue>,
    on_event: &mut Option<&mut (dyn FnMut(&JsonValue) -> Result<()> + Send)>,
) -> Result<()> {
    for value in aggregator.collect(event) {
        if let Some(handler) = on_event.as_mut() {
            handler(&value)?;
        }
        out.push(value);
    }
    Ok(())
}

fn shell_join(parts: &[String]) -> String {
    parts.join(" ")
}

fn optional_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn optional_env_path(key: &str) -> Option<PathBuf> {
    optional_env(key).map(PathBuf::from)
}

fn bool_from_env(key: &str) -> Option<bool> {
    optional_env(key).and_then(|value| match value.to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    })
}

fn resolve_codex_run_timeout() -> Duration {
    optional_env("CODEX_RUN_TIMEOUT_SECONDS")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_CODEX_RUN_TIMEOUT_SECONDS))
}

fn resolve_codex_max_run_retries() -> usize {
    optional_env("CODEX_MAX_RUN_RETRIES")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_CODEX_MAX_RUN_RETRIES)
}

fn resolve_codex_retry_base_delay() -> Duration {
    optional_env("CODEX_RETRY_BASE_DELAY_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_CODEX_RETRY_BASE_DELAY_MS))
}

fn codex_retry_delay(base: Duration, attempt_index: usize) -> Duration {
    let shift = attempt_index.min(4) as u32;
    let multiplier = 1_u32 << shift;
    base.saturating_mul(multiplier)
}

fn should_retry_codex_run(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();

    // Provider/controller error payload matching only. Do not infer runtime behavior from
    // user prompt text here.
    if normalized.contains(" 401")
        || normalized.contains(" 403")
        || normalized.contains("unauthorized")
        || normalized.contains("forbidden")
        || normalized.contains("invalid api key")
        || normalized.contains("insufficient_quota")
        || normalized.contains("rate_limit_error")
        || normalized.contains("rate limit reached")
        || normalized.contains("controller forced credential refresh failed")
        || normalized.contains("codex oauth refresh failed")
        || normalized.contains("session has ended")
        || normalized.contains("please log in again")
    {
        return false;
    }

    normalized.contains("unexpected status 429")
        || normalized.contains("unexpected status 500")
        || normalized.contains("unexpected status 502")
        || normalized.contains("unexpected status 503")
        || normalized.contains("unexpected status 504")
        || normalized.contains("bad gateway")
        || normalized.contains("service unavailable")
        || normalized.contains("gateway timeout")
        || normalized.contains("timed out")
        || normalized.contains(" timeout")
        || normalized.contains("error sending request for url")
        || normalized.contains("connection reset by peer")
        || normalized.contains("connection refused")
        || normalized.contains("codex turn aborted")
}

fn should_terminate_codex_stream(
    http_status_code: Option<u16>,
    stream_error_count: usize,
    max_stream_retries: usize,
) -> bool {
    // Transport disconnects are retried by Codex itself; only auth failures bypass that budget.
    matches!(http_status_code, Some(401 | 403)) || stream_error_count > max_stream_retries
}

fn resolve_codex_home(workspace_dir: &Path) -> PathBuf {
    optional_env("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_dir.join(".codex"))
}

fn ensure_runtime_codex_home(workspace_dir: &Path) -> Result<PathBuf> {
    let codex_home = resolve_codex_home(workspace_dir);
    ensure_codex_home_writable(&codex_home)?;
    Ok(codex_home)
}

fn ensure_codex_home_writable(codex_home: &Path) -> Result<()> {
    fs::create_dir_all(codex_home).with_context(|| {
        format!(
            "failed to create runtime CODEX_HOME directory {}",
            codex_home.display()
        )
    })?;
    let probe_path = codex_home.join(".instafy-write-probe");
    fs::write(&probe_path, b"ok").with_context(|| {
        format!(
            "failed to write runtime CODEX_HOME probe {}",
            probe_path.display()
        )
    })?;
    let _ = fs::remove_file(&probe_path);
    Ok(())
}

fn prepare_fallback_codex_home(workspace_dir: &Path, fallback_home: &Path) -> Result<()> {
    fs::create_dir_all(fallback_home).with_context(|| {
        format!(
            "failed to create fallback CODEX_HOME directory {}",
            fallback_home.display()
        )
    })?;

    let primary_home = resolve_codex_home(workspace_dir);
    let primary_config_path = primary_home.join("config.toml");
    let fallback_config_path = fallback_home.join("config.toml");
    if primary_config_path.is_file() {
        let existing = fs::read_to_string(&primary_config_path).with_context(|| {
            format!(
                "failed to read primary CODEX config {}",
                primary_config_path.display()
            )
        })?;
        let sanitized = sanitize_codex_config_runtime(existing.as_str());
        fs::write(&fallback_config_path, sanitized.as_bytes()).with_context(|| {
            format!(
                "failed to write fallback CODEX config {}",
                fallback_config_path.display()
            )
        })?;
    }

    Ok(())
}

fn repair_codex_config_file(workspace_dir: &Path) -> Result<bool> {
    let codex_home = resolve_codex_home(workspace_dir);
    let config_path = codex_home.join("config.toml");
    if !config_path.is_file() {
        return Ok(false);
    }

    let existing = fs::read_to_string(&config_path).with_context(|| {
        format!(
            "failed to read CODEX config for repair {}",
            config_path.display()
        )
    })?;
    let sanitized = sanitize_codex_config_runtime(existing.as_str());
    if sanitized == existing {
        return Ok(false);
    }
    fs::write(&config_path, sanitized.as_bytes()).with_context(|| {
        format!(
            "failed to write repaired CODEX config {}",
            config_path.display()
        )
    })?;
    Ok(true)
}

fn sanitize_codex_config_runtime(existing: &str) -> String {
    let lines: Vec<&str> = existing.lines().collect();
    let mut retained_lines: Vec<String> = Vec::with_capacity(lines.len());
    let mut index = 0usize;
    let mut seen_mcp_blocks: HashSet<String> = HashSet::new();
    let mut seen_rmcp_setting = false;

    while index < lines.len() {
        let current = lines[index];
        let trimmed = current.trim();
        let stripped = trimmed.split('#').next().unwrap_or("").trim();

        if stripped.starts_with("experimental_use_rmcp_client") {
            if !seen_rmcp_setting {
                retained_lines.push(current.to_string());
                seen_rmcp_setting = true;
            }
            index += 1;
            continue;
        }

        if let Some(server_name) = parse_mcp_server_header(stripped) {
            let block_start = index;
            index += 1;
            while index < lines.len() {
                let next = lines[index].trim();
                let next_stripped = next.split('#').next().unwrap_or("").trim();
                if next_stripped.starts_with('[') {
                    break;
                }
                index += 1;
            }
            // Strip stale `[mcp_servers.playwright]` blocks so the runtime does not advertise
            // browser tools that are unavailable in this execution path.
            if server_name.eq_ignore_ascii_case("playwright") {
                continue;
            }
            if !seen_mcp_blocks.insert(server_name.to_string()) {
                continue;
            }
            retained_lines.extend(
                lines[block_start..index]
                    .iter()
                    .map(|line| (*line).to_string()),
            );
            continue;
        }

        retained_lines.push(current.to_string());
        index += 1;
    }

    let mut compacted = Vec::with_capacity(retained_lines.len());
    let mut previous_blank = false;
    for line in retained_lines {
        let is_blank = line.trim().is_empty();
        if is_blank && previous_blank {
            continue;
        }
        compacted.push(line);
        previous_blank = is_blank;
    }
    while compacted
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        compacted.pop();
    }
    compacted.join("\n")
}

fn parse_mcp_server_header(stripped: &str) -> Option<&str> {
    if !stripped.starts_with("[mcp_servers.") || !stripped.ends_with(']') {
        return None;
    }
    let inner = &stripped["[mcp_servers.".len()..stripped.len() - 1];
    if inner.is_empty() {
        return None;
    }
    Some(inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::mcp::CallToolResult;
    use codex_protocol::protocol::{
        AgentMessageContentDeltaEvent, AgentMessageEvent, ExecCommandBeginEvent,
        ExecCommandEndEvent, ExecCommandOutputDeltaEvent, ExecCommandSource, ExecCommandStatus,
        ExecOutputStream, ItemCompletedEvent, McpInvocation, McpToolCallEndEvent,
        RawResponseItemEvent, TokenCountEvent, TokenUsage, TokenUsageInfo, TurnCompleteEvent,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    struct DropMarker(Arc<AtomicBool>);

    impl Drop for DropMarker {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn fresh_codex_task_is_aborted_when_its_parent_is_cancelled() {
        let child_dropped = Arc::new(AtomicBool::new(false));
        let child_dropped_for_task = Arc::clone(&child_dropped);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let parent = tokio::spawn(run_on_fresh_task(async move {
            let _drop_marker = DropMarker(child_dropped_for_task);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        }));

        started_rx.await.expect("fresh Codex child should start");
        parent.abort();
        let parent_error = parent
            .await
            .expect_err("cancelled parent should not complete");
        assert!(parent_error.is_cancelled());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !child_dropped.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled parent should abort and drop the fresh Codex child");
    }

    #[tokio::test]
    #[should_panic(expected = "fresh Codex task panic")]
    async fn fresh_codex_task_resumes_child_panics() {
        run_on_fresh_task(async {
            panic!("fresh Codex task panic");
        })
        .await;
    }

    #[tokio::test]
    async fn shared_browser_deadline_cancels_but_awaits_fail_closed_cleanup() {
        let cancel_signal = JobCancelSignal::new();
        let signal_for_run = cancel_signal.clone();
        let cleanup_completed = Arc::new(AtomicBool::new(false));
        let cleanup_for_run = cleanup_completed.clone();

        let output = CodexClient::run_shared_browser_with_deadline(
            Duration::from_millis(10),
            Duration::from_millis(100),
            cancel_signal.clone(),
            async move {
                signal_for_run.cancelled().await;
                tokio::time::sleep(Duration::from_millis(10)).await;
                cleanup_for_run.store(true, Ordering::SeqCst);
                Ok("stopped")
            },
        )
        .await;

        assert_eq!(
            output.expect("cooperative cleanup should finish"),
            "stopped"
        );
        assert!(cancel_signal.is_canceled());
        assert!(cleanup_completed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn shared_browser_external_cancellation_bounds_uncooperative_cleanup() {
        let cancel_signal = JobCancelSignal::new();
        cancel_signal.cancel();
        let future_dropped = Arc::new(AtomicBool::new(false));
        let future_dropped_for_run = Arc::clone(&future_dropped);

        let result = timeout(
            Duration::from_millis(100),
            CodexClient::run_shared_browser_with_deadline(
                Duration::from_secs(60),
                Duration::from_millis(20),
                cancel_signal.clone(),
                async move {
                    let _drop_marker = DropMarker(future_dropped_for_run);
                    std::future::pending::<Result<()>>().await
                },
            ),
        )
        .await
        .expect("external cancellation must not wait for the run deadline");

        assert!(
            result
                .expect_err("uncooperative cleanup must fail closed")
                .to_string()
                .contains("runtime recycle required")
        );
        assert!(cancel_signal.is_canceled());
        assert!(!cancel_signal.shared_browser_shutdown_is_confirmed());
        assert!(future_dropped.load(Ordering::SeqCst));
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock poisoned")
    }

    fn count_setting_lines(config: &str, key: &str) -> usize {
        config
            .lines()
            .filter(|line| {
                line.trim()
                    .split('#')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .starts_with(key)
            })
            .count()
    }

    #[test]
    fn structured_runtime_prompt_names_command_tools_for_command_required_turns() {
        assert!(STRUCTURED_RUNTIME_DEVELOPER_INSTRUCTIONS.contains("exec_command"));
        assert!(STRUCTURED_RUNTIME_DEVELOPER_INSTRUCTIONS.contains("shell"));
        assert!(
            STRUCTURED_RUNTIME_DEVELOPER_INSTRUCTIONS.contains("Apply relevant skills silently")
        );
        assert!(STRUCTURED_RUNTIME_BASE_INSTRUCTIONS.contains("exec_command"));
        assert!(STRUCTURED_RUNTIME_BASE_INSTRUCTIONS.contains("shell"));
        assert!(STRUCTURED_RUNTIME_BASE_INSTRUCTIONS.contains("Apply skills silently"));
        assert!(
            STRUCTURED_RUNTIME_BASE_INSTRUCTIONS
                .contains("do not end the turn with reasoning only")
        );
        assert!(
            PLAIN_FINAL_RUNTIME_DEVELOPER_INSTRUCTIONS.contains("normal final assistant message")
        );
        assert!(PLAIN_FINAL_RUNTIME_BASE_INSTRUCTIONS.contains("normal user-facing prose"));
        assert!(PLAIN_FINAL_RUNTIME_BASE_INSTRUCTIONS.contains("exec_command"));
    }

    #[test]
    fn personal_browser_policy_is_appended_only_for_capable_desktop_runtimes() {
        let base = "Browser/UI execution run".to_string();
        assert_eq!(
            append_personal_browser_developer_instructions(base.clone(), false),
            base
        );

        let enabled = append_personal_browser_developer_instructions(base, true);
        assert!(enabled.contains("instafy_personal_browser"));
        assert!(enabled.contains("dedicated tools"));
        assert!(enabled.contains("instead of Playwright"));
        assert!(enabled.contains("unavailable to shell tools"));
    }

    #[test]
    fn shared_browser_policy_uses_the_bounded_mcp_server() {
        let base = "Browser/UI execution run".to_string();
        assert_eq!(
            append_shared_browser_developer_instructions(base.clone(), false),
            base
        );
        let enabled = append_shared_browser_developer_instructions(base, true);
        assert!(enabled.contains("instafy_shared_browser"));
        assert!(enabled.contains("snapshotId"));
        assert!(enabled.contains("Arbitrary CSS selectors are not accepted"));
        assert!(enabled.contains("visible AI cursor"));
        assert!(enabled.contains("Do not invoke Shared Browser through shell"));
        assert!(enabled.contains("Allow once"));
        assert!(enabled.contains("typed-text operation"));
        assert!(enabled.contains("key press"));
        assert!(enabled.contains("Do not retry it automatically"));
        assert!(enabled.contains("never a model-visible tool"));
    }

    #[test]
    fn every_job_strips_all_browser_capabilities_from_shell_children() {
        let mut policy = ShellEnvironmentPolicy::default();
        for key in [
            PERSONAL_BROWSER_CONTROL_TOKEN_ENV,
            SHARED_BROWSER_CDP_URL_ENV,
            SHARED_BROWSER_PAGE_ID_ENV,
            SHARED_BROWSER_PLAYWRIGHT_MODULE_PATH_ENV,
            SHARED_BROWSER_AGENT_CONTROL_FILE_ENV,
            SHARED_BROWSER_APPROVAL_DIR_ENV,
            SHARED_BROWSER_APPROVAL_TIMEOUT_MS_ENV,
        ] {
            policy
                .r#set
                .insert(key.to_string(), "must-not-survive".to_string());
        }

        scope_browser_capabilities_from_shell_environment(&mut policy);

        for key in [
            PERSONAL_BROWSER_CONTROL_TOKEN_ENV,
            SHARED_BROWSER_CDP_URL_ENV,
            SHARED_BROWSER_PAGE_ID_ENV,
            SHARED_BROWSER_PLAYWRIGHT_MODULE_PATH_ENV,
            SHARED_BROWSER_AGENT_CONTROL_FILE_ENV,
            SHARED_BROWSER_APPROVAL_DIR_ENV,
            SHARED_BROWSER_APPROVAL_TIMEOUT_MS_ENV,
        ] {
            assert!(!policy.r#set.contains_key(key));
        }
        assert_eq!(policy.exclude.len(), 14);

        let mut fresh_policy = ShellEnvironmentPolicy::default();
        scope_browser_capabilities_from_shell_environment(&mut fresh_policy);
        assert_eq!(fresh_policy.exclude.len(), 14);
    }

    #[test]
    fn personal_browser_mcp_config_is_never_serialized_for_refresh() {
        assert!(!should_refresh_mcp_servers(true, true, true));
        assert!(should_refresh_mcp_servers(true, false, true));
        assert!(!should_refresh_mcp_servers(false, false, true));
        assert!(!should_refresh_mcp_servers(true, false, false));
    }

    #[test]
    fn personal_browser_capability_contract_matches_the_exact_bounded_turn() {
        assert_eq!(
            personal_browser_capability_contract().expect("Personal Browser contract"),
            json!({
                "schemaVersion": 1,
                "browserTransport": "desktop-personal",
                "mcpServers": [{
                    "name": "instafy_personal_browser",
                    "required": true,
                    "supportsParallelToolCalls": false,
                    "enabledTools": [
                        "status", "snapshot", "navigate", "click", "type", "press", "scroll"
                    ],
                }],
                "projectMcpServersAllowed": false,
                "localExecutionEnvironmentCount": 0,
            })
        );
    }

    #[test]
    fn bounded_browser_contract_rejects_any_additional_project_mcp_server() {
        let server = || {
            browser_mcp_server_config(McpServerTransportConfig::StreamableHttp {
                url: "http://127.0.0.1/contract-only".to_string(),
                bearer_token_env_var: None,
                http_headers: None,
                env_http_headers: None,
            })
        };
        let servers = HashMap::from([
            (PERSONAL_BROWSER_MCP_SERVER_NAME.to_string(), server()),
            ("workspace-configured-server".to_string(), server()),
        ]);

        let error =
            validate_bounded_browser_mcp_server_set(&servers, PERSONAL_BROWSER_MCP_SERVER_NAME)
                .expect_err("additional MCP server must fail closed")
                .to_string();
        assert!(error.contains("exactly one MCP server"));
    }

    #[test]
    fn scoped_job_shell_environment_exposes_only_the_per_job_controller_token() {
        use codex_protocol::shell_environment::create_env_from_vars;

        let mut policy = ShellEnvironmentPolicy::default();
        for key in INTERNAL_CREDENTIAL_ENV_KEYS
            .iter()
            .chain(MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS)
        {
            policy
                .r#set
                .insert((*key).to_string(), "configured-machine-secret".to_string());
        }

        scope_runtime_model_shell_environment(&mut policy);

        let mut inherited = INTERNAL_CREDENTIAL_ENV_KEYS
            .iter()
            .chain(MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS)
            .map(|key| ((*key).to_string(), "inherited-machine-secret".to_string()))
            .collect::<Vec<_>>();
        inherited.extend([
            (
                "CONTROLLER_ACCESS_TOKEN".to_string(),
                "verified-job-token".to_string(),
            ),
            (
                "CODEX_API_KEY".to_string(),
                "proxy-envelope-token".to_string(),
            ),
            ("GITHUB_TOKEN".to_string(), "project-job-secret".to_string()),
        ]);

        let child_env = create_env_from_vars(inherited, &policy, None);
        for key in INTERNAL_CREDENTIAL_ENV_KEYS
            .iter()
            .chain(MODEL_CHILD_ONLY_EXCLUDED_ENV_KEYS)
        {
            assert!(
                !child_env
                    .keys()
                    .any(|candidate| candidate.eq_ignore_ascii_case(key)),
                "model shell inherited internal credential {key}"
            );
            assert!(
                !policy
                    .r#set
                    .keys()
                    .any(|candidate| candidate.eq_ignore_ascii_case(key)),
                "configured shell override retained internal credential {key}"
            );
        }
        assert_eq!(
            child_env.get("CONTROLLER_ACCESS_TOKEN").map(String::as_str),
            Some("verified-job-token")
        );
        assert_eq!(
            child_env.get("CODEX_API_KEY").map(String::as_str),
            Some("proxy-envelope-token")
        );
        assert_eq!(
            child_env.get("GITHUB_TOKEN").map(String::as_str),
            Some("project-job-secret")
        );
        for alias in ["CONTROLLER_TOKEN", "CONTROLLER_BEARER"] {
            assert!(is_model_child_excluded_env_key(alias));
            assert!(!child_env.contains_key(alias));
        }
    }

    #[test]
    fn parse_codex_final_message_accepts_raw_json() {
        let parsed = parse_codex_final_message("{\"summary\":\"ok\",\"files\":[]}").unwrap();
        assert_eq!(parsed["summary"], "ok");
    }

    #[test]
    fn parse_codex_final_message_accepts_fenced_json() {
        let parsed = parse_codex_final_message("```json\n{\"summary\":\"ok\"}\n```").unwrap();
        assert_eq!(parsed["summary"], "ok");
    }

    #[test]
    fn parse_codex_final_message_accepts_prose_wrapped_json() {
        let parsed =
            parse_codex_final_message("Here you go:\n```json\n{\"summary\":\"ok\"}\n```\n")
                .unwrap();
        assert_eq!(parsed["summary"], "ok");
    }

    #[test]
    fn parse_codex_final_message_accepts_escaped_structural_quotes() {
        let parsed = parse_codex_final_message(r#"{\"summary\":\"ok\",\"files\":[]}"#).unwrap();
        assert_eq!(parsed["summary"], "ok");
    }

    #[test]
    fn parse_codex_final_message_accepts_fenced_escaped_structural_quotes() {
        let parsed =
            parse_codex_final_message("Here you go:\n```json\n{\\\"summary\\\":\\\"ok\\\"}\n```\n")
                .unwrap();
        assert_eq!(parsed["summary"], "ok");
    }

    #[test]
    fn parse_codex_final_message_repairs_control_chars_in_strings() {
        let raw = "{\n  \"summary\": \"ok\",\n  \"files\": [\n    {\n      \"path\": \"hello.txt\",\n      \"workspacePath\": \"hello.txt\",\n      \"change\": {\"type\":\"created\"},\n      \"content\": \"line1\nline2\"\n    }\n  ]\n}\n";
        let parsed = parse_codex_final_message(raw).unwrap();
        assert_eq!(parsed["summary"], "ok");
        assert_eq!(parsed["files"][0]["content"], "line1\nline2");
    }

    #[test]
    fn runtime_chatgpt_base_url_from_env_uses_proxy_base_url() {
        let _env_lock = env_lock();
        unsafe { std::env::set_var("PROXY_BASE_URL", "http://proxy:8789/") };
        assert_eq!(
            runtime_chatgpt_base_url_from_env().as_deref(),
            Some("http://proxy:8789/backend-api/")
        );
        unsafe { std::env::remove_var("PROXY_BASE_URL") };
    }

    #[test]
    fn runtime_security_overrides_disable_shell_snapshot_feature() {
        let mut features = ManagedFeatures::default();
        features
            .enable(Feature::ShellSnapshot)
            .expect("enable shell snapshot");
        features
            .enable(Feature::Personality)
            .expect("enable personality");
        assert!(features.enabled(Feature::ShellSnapshot));
        assert!(features.enabled(Feature::Personality));

        apply_runtime_security_feature_overrides(&mut features);

        assert!(!features.enabled(Feature::ShellSnapshot));
        assert!(!features.enabled(Feature::Personality));
    }

    #[test]
    fn bounded_browser_turn_disables_every_non_browser_capability_feature() {
        let mut features = ManagedFeatures::default();
        for feature in bounded_browser_disabled_features() {
            features.enable(feature).expect("enable feature for test");
        }

        disable_bounded_browser_features(&mut features).expect("disable bounded-browser features");

        for feature in bounded_browser_disabled_features() {
            assert!(!features.enabled(feature), "{feature:?} remained enabled");
        }
    }

    #[test]
    fn bounded_browser_turn_has_no_local_execution_environment() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let cwd = AbsolutePathBuf::try_from(workspace.path().to_path_buf())
            .expect("absolute workspace path");

        let bounded = turn_environment_selections(cwd.clone(), true);
        assert!(bounded.environments.is_empty());

        let ordinary = turn_environment_selections(cwd, false);
        assert_eq!(ordinary.environments.len(), 1);
        assert_eq!(
            ordinary.environments[0].environment_id,
            LOCAL_ENVIRONMENT_ID
        );
    }

    #[test]
    fn cleanup_workspace_local_shell_snapshots_removes_runtime_cache_dirs() {
        let _env_lock = env_lock();
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let shared_root = tempfile::tempdir().expect("shared CODEX_HOME tempdir");
        let shared_codex_home = shared_root.path().join("shared-codex-home");
        let shared_snapshots = shared_codex_home.join("shell_snapshots");
        let previous_codex_home = std::env::var_os("CODEX_HOME");
        unsafe { std::env::set_var("CODEX_HOME", &shared_codex_home) };
        let primary_snapshots = workspace.path().join(".codex").join("shell_snapshots");
        let fallback_snapshots = workspace
            .path()
            .join(".codex-runtime-fallback")
            .join("shell_snapshots");
        std::fs::create_dir_all(&primary_snapshots).expect("primary snapshot dir");
        std::fs::create_dir_all(&fallback_snapshots).expect("fallback snapshot dir");
        std::fs::create_dir_all(&shared_snapshots).expect("shared snapshot dir");
        std::fs::write(primary_snapshots.join("snapshot.sh"), "export SECRET=value")
            .expect("primary snapshot");
        std::fs::write(
            fallback_snapshots.join("snapshot.sh"),
            "export SECRET=value",
        )
        .expect("fallback snapshot");
        std::fs::write(
            shared_snapshots.join("snapshot.sh"),
            "export RUNTIME_ACCESS_TOKEN=stale-machine-token",
        )
        .expect("shared CODEX_HOME snapshot");

        cleanup_workspace_local_shell_snapshots(workspace.path());

        assert!(!primary_snapshots.exists());
        assert!(!fallback_snapshots.exists());
        assert!(!shared_snapshots.exists());

        match previous_codex_home {
            Some(value) => unsafe { std::env::set_var("CODEX_HOME", value) },
            None => unsafe { std::env::remove_var("CODEX_HOME") },
        }
    }

    #[test]
    fn normalize_runtime_codex_model_id_migrates_retired_codex_slugs() {
        assert_eq!(
            normalize_runtime_codex_model_id("gpt-5-codex"),
            "gpt-5.6-sol"
        );
        assert_eq!(normalize_runtime_codex_model_id("gpt-5.2"), "gpt-5.6-sol");
        assert_eq!(
            normalize_runtime_codex_model_id("gpt-5.3-codex"),
            "gpt-5.6-sol"
        );
        assert_eq!(normalize_runtime_codex_model_id("gpt-5.3"), "gpt-5.6-sol");
        assert_eq!(normalize_runtime_codex_model_id("gpt-5.4"), "gpt-5.6-sol");
        assert_eq!(normalize_runtime_codex_model_id("  "), "gpt-5.6-sol");
    }

    #[test]
    fn final_output_json_schema_is_enabled_by_default_for_runtime_runs() {
        let _env_lock = env_lock();
        let previous = std::env::var_os("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA");
        unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") };

        let schema = final_output_json_schema_for_run(
            WireApi::Responses,
            false,
            false,
            CodexFinalOutputSchema::Default,
        )
        .expect("schema should be present by default");
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["required"],
            json!(["summary", "code", "suggestions", "files", "actions"])
        );
        assert_eq!(
            schema["properties"]["files"]["items"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["properties"]["actions"]["items"]["additionalProperties"],
            false
        );

        match previous {
            Some(value) => unsafe {
                std::env::set_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA", value)
            },
            None => unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") },
        }
    }

    #[test]
    fn structured_runtime_instructions_allow_inline_file_writes_without_shell_tools() {
        assert!(STRUCTURED_RUNTIME_DEVELOPER_INSTRUCTIONS.contains("inline `files[]`"));
        assert!(
            STRUCTURED_RUNTIME_DEVELOPER_INSTRUCTIONS
                .contains("do not require `exec_command` or `shell`")
        );
        assert!(STRUCTURED_RUNTIME_BASE_INSTRUCTIONS.contains("executable runtime write path"));
        assert!(
            STRUCTURED_RUNTIME_BASE_INSTRUCTIONS
                .contains("does not require `exec_command` or `shell`")
        );
    }

    #[test]
    fn final_output_json_schema_can_be_disabled_explicitly() {
        let _env_lock = env_lock();
        let previous = std::env::var_os("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA");
        unsafe { std::env::set_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA", "1") };

        assert!(
            final_output_json_schema_for_run(
                WireApi::Responses,
                false,
                false,
                CodexFinalOutputSchema::Default,
            )
            .is_none()
        );
        assert!(
            final_output_json_schema_for_run(
                WireApi::Responses,
                true,
                false,
                CodexFinalOutputSchema::Default,
            )
            .is_none()
        );
        assert!(
            final_output_json_schema_for_run(
                WireApi::Responses,
                false,
                true,
                CodexFinalOutputSchema::Default,
            )
            .is_none()
        );

        match previous {
            Some(value) => unsafe {
                std::env::set_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA", value)
            },
            None => unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") },
        }
    }

    #[test]
    fn final_output_json_schema_survives_shell_tool_disable() {
        let _env_lock = env_lock();
        let previous = std::env::var_os("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA");
        unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") };

        let schema = final_output_json_schema_for_run(
            WireApi::Responses,
            true,
            false,
            CodexFinalOutputSchema::Default,
        )
        .expect("schema should remain available when shell tools are disabled");
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);

        match previous {
            Some(value) => unsafe {
                std::env::set_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA", value)
            },
            None => unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") },
        }
    }

    #[test]
    fn final_output_json_schema_supports_multi_agent_plan_actions() {
        let _env_lock = env_lock();
        let previous = std::env::var_os("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA");
        unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") };

        let schema = final_output_json_schema_for_run(
            WireApi::Responses,
            false,
            false,
            CodexFinalOutputSchema::MultiAgentPlan,
        )
        .expect("multi-agent schema should be present");
        let action = &schema["properties"]["actions"]["items"];
        assert_eq!(action["additionalProperties"], false);
        assert!(
            action["required"]
                .as_array()
                .unwrap()
                .contains(&json!("agents"))
        );
        assert!(
            action["required"]
                .as_array()
                .unwrap()
                .contains(&json!("lead"))
        );
        assert_eq!(
            action["properties"]["agents"]["items"]["properties"]["writeScope"]["additionalProperties"],
            false
        );

        match previous {
            Some(value) => unsafe {
                std::env::set_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA", value)
            },
            None => unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") },
        }
    }

    #[test]
    fn routing_preflight_schema_requires_all_declared_properties() {
        let _env_lock = env_lock();
        let previous = std::env::var_os("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA");
        unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") };

        let schema = final_output_json_schema_for_run(
            WireApi::Responses,
            false,
            false,
            CodexFinalOutputSchema::RoutingPreflight,
        )
        .expect("routing preflight schema should be present");
        let required = schema["required"]
            .as_array()
            .expect("routing preflight schema should declare required fields");
        for key in schema["properties"]
            .as_object()
            .expect("routing preflight schema should declare properties")
            .keys()
        {
            assert!(
                required.contains(&json!(key)),
                "routing preflight schema should require declared property {key}"
            );
        }

        match previous {
            Some(value) => unsafe {
                std::env::set_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA", value)
            },
            None => unsafe { std::env::remove_var("CODEX_DISABLE_FINAL_OUTPUT_JSON_SCHEMA") },
        }
    }

    #[test]
    fn derive_final_json_falls_back_to_agent_message_event_when_turn_message_is_not_json() {
        let turn_message = Some("Running tasks...");
        let agent_message = Some("```json\n{\"summary\":\"ok-from-event\",\"files\":[]}\n```");

        let parsed =
            derive_final_json(turn_message, None, agent_message, None, None, false).unwrap();
        assert_eq!(parsed["summary"], "ok-from-event");
    }

    #[test]
    fn derive_final_json_falls_back_to_completed_agent_message_item_when_turn_message_is_missing() {
        let completed_agent_message =
            Some("```json\n{\"summary\":\"ok-from-item\",\"files\":[]}\n```");

        let parsed =
            derive_final_json(None, completed_agent_message, None, None, None, false).unwrap();
        assert_eq!(parsed["summary"], "ok-from-item");
    }

    #[test]
    fn derive_final_json_uses_text_fallback_when_no_json_candidates_exist() {
        let turn_message = Some("plain text response without json");
        let parsed = derive_final_json(turn_message, None, None, None, None, false).unwrap();

        let summary = parsed["summary"].as_str().unwrap_or_default();
        assert!(
            summary.contains("final assistant message was not valid JSON"),
            "unexpected summary: {summary}"
        );
        assert!(
            summary.contains("plain text response without json"),
            "unexpected summary: {summary}"
        );
        assert_eq!(parsed["files"], json!([]));
    }

    #[test]
    fn derive_final_json_can_recover_plain_text_as_summary() {
        let turn_message = Some("Plain text recovery summary.");
        let parsed = derive_final_json(turn_message, None, None, None, None, true).unwrap();

        assert_eq!(parsed["summary"], "Plain text recovery summary.");
        assert_eq!(parsed["files"], json!([]));
    }

    #[test]
    fn derive_final_json_uses_empty_fallback_when_no_candidates_exist() {
        let parsed = derive_final_json(None, None, None, None, None, false).unwrap();
        assert_eq!(parsed["summary"], MISSING_FINAL_ASSISTANT_MESSAGE_SUMMARY);
        assert_eq!(parsed["files"], json!([]));
    }

    #[test]
    fn derive_final_json_reports_commentary_only_turns() {
        let parsed = derive_final_json(
            None,
            None,
            None,
            Some("I am locating the imported project first."),
            None,
            false,
        )
        .unwrap();

        let summary = parsed["summary"].as_str().unwrap_or_default();
        assert!(summary.contains("progress/commentary message"));
        assert!(summary.contains("I am locating the imported project first."));
        assert_eq!(parsed["files"], json!([]));
    }

    #[test]
    fn derive_final_json_accepts_json_commentary_as_schema_free_recovery_final() {
        let parsed = derive_final_json(
            None,
            None,
            None,
            Some(
                r#"{"summary":"Goal cannot be verified without runtime evidence.","files":[],"actions":[{"type":"goal_update","status":"blocked","objective":"verify board connection"}]}"#,
            ),
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            parsed["summary"],
            "Goal cannot be verified without runtime evidence."
        );
        assert_eq!(parsed["actions"][0]["type"], "goal_update");
        assert_eq!(parsed["actions"][0]["status"], "blocked");
    }

    #[test]
    fn derive_final_json_recovers_commentary_only_turns_when_plain_text_fallback_is_allowed() {
        let parsed = derive_final_json(
            None,
            None,
            None,
            Some("Inspected checkout: `repos/example-device-provider`."),
            None,
            true,
        )
        .unwrap();

        assert_eq!(
            parsed["summary"],
            "Inspected checkout: `repos/example-device-provider`."
        );
        assert_eq!(parsed["files"], json!([]));
        assert_eq!(
            classify_internal_codex_fallback_summary(
                parsed["summary"].as_str().unwrap_or_default()
            ),
            None
        );
    }

    #[test]
    fn derive_final_json_reports_reasoning_only_turns_as_progress() {
        let parsed = derive_final_json(
            None,
            None,
            None,
            None,
            Some("Examining the workspace layout before writing the guide."),
            false,
        )
        .unwrap();

        let summary = parsed["summary"].as_str().unwrap_or_default();
        assert!(
            summary.starts_with(COMMENTARY_ONLY_FINAL_ASSISTANT_MESSAGE_SUMMARY_PREFIX),
            "unexpected summary: {summary}"
        );
        assert!(summary.contains("Last progress output:"));
        assert!(summary.contains("Examining the workspace layout before writing the guide."));
        assert_ne!(summary, MISSING_FINAL_ASSISTANT_MESSAGE_SUMMARY);
        assert_eq!(parsed["files"], json!([]));
        assert_eq!(
            classify_internal_codex_fallback_summary(summary),
            Some(CodexFallbackSummaryKind::MissingFinalAssistantMessage)
        );
    }

    #[test]
    fn derive_final_json_reasoning_stays_progress_even_when_plain_text_fallback_is_allowed() {
        let parsed = derive_final_json(
            None,
            None,
            None,
            None,
            Some("Weighing patch strategies."),
            true,
        )
        .unwrap();

        let summary = parsed["summary"].as_str().unwrap_or_default();
        assert!(
            summary.starts_with(COMMENTARY_ONLY_FINAL_ASSISTANT_MESSAGE_SUMMARY_PREFIX),
            "reasoning must never become a plain-text final: {summary}"
        );
        assert!(summary.contains("Weighing patch strategies."));
    }

    #[test]
    fn derive_final_json_prefers_commentary_over_reasoning() {
        let parsed = derive_final_json(
            None,
            None,
            None,
            Some("I am locating the imported project first."),
            Some("Considering directory listings."),
            false,
        )
        .unwrap();

        let summary = parsed["summary"].as_str().unwrap_or_default();
        assert!(summary.contains("I am locating the imported project first."));
        assert!(!summary.contains("Considering directory listings."));
    }

    #[test]
    fn classify_internal_codex_fallback_summary_detects_empty_and_invalid_json_fallbacks() {
        assert_eq!(
            classify_internal_codex_fallback_summary(MISSING_FINAL_ASSISTANT_MESSAGE_SUMMARY),
            Some(CodexFallbackSummaryKind::MissingFinalAssistantMessage)
        );
        assert_eq!(
            classify_internal_codex_fallback_summary(
                "Codex automation completed, but the final assistant message was not valid JSON.\n\nRaw assistant output:\nplain text"
            ),
            Some(CodexFallbackSummaryKind::InvalidFinalAssistantMessageJson)
        );
        assert_eq!(
            classify_internal_codex_fallback_summary(
                "Codex automation stopped after a progress/commentary message without returning a final assistant message.\n\nLast progress output:\nworking"
            ),
            Some(CodexFallbackSummaryKind::MissingFinalAssistantMessage)
        );
        assert_eq!(
            classify_internal_codex_fallback_summary("Updated the requested file."),
            None
        );
    }

    #[test]
    fn latest_completed_agent_message_from_events_uses_latest_completed_agent_message_item() {
        let events = vec![
            json!({
                "type": "item.completed",
                "item": {
                    "type": "reasoning",
                    "text": "Thinking…"
                }
            }),
            json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": "first"
                }
            }),
            json!({
                "type": "item.updated",
                "item": {
                    "type": "agent_message",
                    "text": "ignore updated"
                }
            }),
            json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": "latest"
                }
            }),
        ];

        assert_eq!(
            latest_completed_agent_message_from_events(&events),
            Some("latest")
        );
    }

    #[test]
    fn latest_completed_reasoning_message_from_events_uses_latest_completed_reasoning_item() {
        let events = vec![
            json!({
                "type": "item.completed",
                "item": {
                    "type": "reasoning",
                    "text": "first thought"
                }
            }),
            json!({
                "type": "item.updated",
                "item": {
                    "type": "reasoning",
                    "text": "ignore in-progress delta"
                }
            }),
            json!({
                "type": "item.completed",
                "item": {
                    "type": "reasoning",
                    "text": "latest thought"
                }
            }),
            json!({
                "type": "item.completed",
                "item": {
                    "type": "command_execution",
                    "command": "ls"
                }
            }),
        ];

        assert_eq!(
            latest_completed_reasoning_message_from_events(&events),
            Some("latest thought")
        );
        assert_eq!(latest_completed_reasoning_message_from_events(&[]), None);
    }

    #[test]
    fn should_retry_codex_run_accepts_transient_gateway_errors() {
        assert!(should_retry_codex_run(
            "unexpected status 502 Bad Gateway: upstream request failed"
        ));
        assert!(should_retry_codex_run(
            "error sending request for url (https://chatgpt.com/backend-api/codex/responses)"
        ));
        assert!(should_retry_codex_run(
            "unexpected status 429 Too Many Requests"
        ));
        assert!(should_retry_codex_run("Codex turn aborted (interrupted)"));
    }

    #[test]
    fn transient_stream_transport_errors_use_the_bounded_retry_budget() {
        assert!(!should_terminate_codex_stream(None, 0, 5));
        assert!(!should_terminate_codex_stream(None, 5, 5));
        assert!(should_terminate_codex_stream(None, 6, 5));
    }

    #[test]
    fn stream_auth_errors_still_fail_fast() {
        assert!(should_terminate_codex_stream(Some(401), 0, 5));
        assert!(should_terminate_codex_stream(Some(403), 0, 5));
    }

    #[test]
    fn should_retry_codex_run_rejects_auth_errors() {
        assert!(!should_retry_codex_run(
            "unexpected status 401 Unauthorized"
        ));
        assert!(!should_retry_codex_run("unexpected status 403 Forbidden"));
        assert!(!should_retry_codex_run("invalid api key"));
        assert!(!should_retry_codex_run(
            "unexpected status 502 Bad Gateway: upstream request failed: controller forced credential refresh failed: controller credentials returned 500 Internal Server Error: {\"message\":\"Codex OAuth refresh failed: Your session has ended. Please log in again.\"}"
        ));
    }

    #[test]
    fn should_retry_codex_run_rejects_provider_quota_errors() {
        assert!(!should_retry_codex_run(
            "backend responded with 429 Too Many Requests: {\"error\":{\"type\":\"insufficient_quota\",\"code\":\"insufficient_quota\"}}"
        ));
        assert!(!should_retry_codex_run(
            "backend responded with 429 Too Many Requests: {\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Rate limit reached\"}}"
        ));
    }

    #[test]
    fn sanitize_codex_config_runtime_removes_duplicate_playwright_and_rmcp_entries() {
        let config = r#"
experimental_use_rmcp_client = true
experimental_use_rmcp_client = true

[mcp_servers.playwright]
url = "http://localhost:47991/mcp"
required = false

[mcp_servers.playwright]
url = "http://localhost:47991/mcp"
required = true
"#;
        let sanitized = sanitize_codex_config_runtime(config);
        assert_eq!(sanitized.matches("[mcp_servers.playwright]").count(), 0);
        assert_eq!(
            count_setting_lines(&sanitized, "experimental_use_rmcp_client"),
            1
        );
        assert!(!sanitized.contains("required = false"));
        assert!(!sanitized.contains("required = true"));
    }

    #[test]
    fn sanitize_codex_config_runtime_dedupes_duplicate_non_playwright_mcp_servers() {
        let config = r#"
[mcp_servers.datagouv]
url = "https://mcp.data.gouv.fr/mcp"
required = false

[mcp_servers.datagouv]
url = "https://mcp.data.gouv.fr/mcp"
required = true
"#;
        let sanitized = sanitize_codex_config_runtime(config);
        assert_eq!(sanitized.matches("[mcp_servers.datagouv]").count(), 1);
        assert!(sanitized.contains("required = false"));
        assert!(!sanitized.contains("required = true"));
    }

    #[test]
    fn ensure_runtime_codex_home_creates_missing_home() {
        let _env_lock = env_lock();
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let codex_home = workspace.path().join("missing-codex-home");
        let previous = std::env::var_os("CODEX_HOME");
        unsafe { std::env::set_var("CODEX_HOME", &codex_home) };

        let ensured = ensure_runtime_codex_home(workspace.path()).expect("ensure codex home");

        assert_eq!(ensured, codex_home);
        assert!(ensured.is_dir());

        match previous {
            Some(value) => unsafe { std::env::set_var("CODEX_HOME", value) },
            None => unsafe { std::env::remove_var("CODEX_HOME") },
        }
    }

    #[test]
    fn prepare_fallback_codex_home_copies_only_sanitized_primary_config() {
        let _env_lock = env_lock();
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let primary_home = workspace.path().join(".codex");
        std::fs::create_dir_all(&primary_home).expect("primary codex home");
        std::fs::write(
            primary_home.join("config.toml"),
            r#"
experimental_use_rmcp_client = true
experimental_use_rmcp_client = true

[mcp_servers.playwright]
url = "http://localhost:47991/mcp"
required = false

[mcp_servers.playwright]
url = "http://localhost:47991/mcp"
required = true

[mcp_servers.datagouv]
url = "https://mcp.data.gouv.fr/mcp"
required = true
"#,
        )
        .expect("write primary config");
        let credential_payload = "{\"tokens\":{\"access_token\":\"must-not-copy\"}}";
        std::fs::write(primary_home.join("auth.json"), credential_payload)
            .expect("write primary credential");

        let fallback_home = workspace.path().join(".codex-runtime-fallback");
        prepare_fallback_codex_home(workspace.path(), &fallback_home)
            .expect("prepare fallback home");

        let fallback_config =
            std::fs::read_to_string(fallback_home.join("config.toml")).expect("fallback config");
        assert_eq!(
            fallback_config.matches("[mcp_servers.playwright]").count(),
            0
        );
        assert_eq!(
            count_setting_lines(&fallback_config, "experimental_use_rmcp_client"),
            1
        );
        assert!(fallback_config.contains("[mcp_servers.datagouv]"));
        assert!(!fallback_home.join("auth.json").exists());
        let fallback_entries = std::fs::read_dir(&fallback_home)
            .expect("fallback directory")
            .map(|entry| entry.expect("fallback entry").path())
            .collect::<Vec<_>>();
        for path in fallback_entries {
            if path.is_file() {
                let contents = std::fs::read_to_string(&path).expect("read fallback file");
                assert!(!contents.contains("must-not-copy"));
            }
        }
    }

    #[test]
    fn extract_thread_id_from_provider_state_prefers_mode_specific_key() {
        let default_thread = ThreadId::new();
        let browser_thread = ThreadId::new();
        let state = json!({
            "defaultThreadId": default_thread.to_string(),
            "browserThreadId": browser_thread.to_string(),
            "threadId": default_thread.to_string(),
        });

        let resolved_browser =
            extract_thread_id_from_provider_state(Some(&state), thread_mode_key(true))
                .expect("browser thread id should resolve");
        let resolved_default =
            extract_thread_id_from_provider_state(Some(&state), thread_mode_key(false))
                .expect("default thread id should resolve");
        assert_eq!(resolved_browser, browser_thread);
        assert_eq!(resolved_default, default_thread);
    }

    #[test]
    fn extract_thread_id_from_provider_state_uses_legacy_thread_id() {
        let legacy_thread = ThreadId::new();
        let state = json!({
            "threadId": legacy_thread.to_string(),
        });
        let resolved = extract_thread_id_from_provider_state(Some(&state), thread_mode_key(false))
            .expect("legacy thread id should resolve");
        assert_eq!(resolved, legacy_thread);
    }

    #[test]
    fn extract_rollout_path_from_provider_state_prefers_mode_specific_key() {
        let state = json!({
            "defaultRolloutPath": "/tmp/default-rollout.jsonl",
            "browserRolloutPath": "/tmp/browser-rollout.jsonl",
            "rolloutPath": "/tmp/legacy-rollout.jsonl",
        });
        let browser = extract_rollout_path_from_provider_state(Some(&state), thread_mode_key(true))
            .expect("browser rollout path should resolve");
        let default =
            extract_rollout_path_from_provider_state(Some(&state), thread_mode_key(false))
                .expect("default rollout path should resolve");
        assert_eq!(browser, PathBuf::from("/tmp/browser-rollout.jsonl"));
        assert_eq!(default, PathBuf::from("/tmp/default-rollout.jsonl"));
    }

    #[test]
    fn update_provider_conversation_state_sets_provider_thread_rollout_and_restore_flags() {
        let existing = json!({
            "foo": "bar",
            "defaultThreadId": "stale",
            "defaultThreadRestoreFailed": true,
        });
        let thread_id = ThreadId::new();
        let updated = update_provider_conversation_state(
            Some(&existing),
            thread_mode_key(false),
            &thread_id,
            Some(Path::new("/tmp/default-rollout.jsonl")),
            false,
            "memory",
        );

        assert_eq!(updated["foo"], "bar");
        assert_eq!(updated["provider"], "codex-embedded");
        assert_eq!(updated["version"], 2);
        assert_eq!(updated["defaultThreadId"], thread_id.to_string());
        assert_eq!(updated["threadId"], thread_id.to_string());
        assert_eq!(updated["defaultRolloutPath"], "/tmp/default-rollout.jsonl");
        assert_eq!(updated["rolloutPath"], "/tmp/default-rollout.jsonl");
        assert_eq!(updated["defaultThreadRestoreFailed"], false);
        assert_eq!(updated["defaultThreadRestoreSource"], "memory");
        assert_eq!(updated["lastThreadRestoreSource"], "memory");
        assert_eq!(updated["historyReplayRequired"], false);
    }

    #[test]
    fn codex_event_stream_adapter_tracks_command_execution_lifecycle() {
        let mut adapter = CodexEventStreamAdapter::default();
        let cwd =
            AbsolutePathBuf::from_absolute_path(Path::new("/tmp")).expect("absolute /tmp path");

        let started = adapter.collect(&Event {
            id: "evt_begin".to_string(),
            msg: EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                call_id: "call_1".to_string(),
                process_id: None,
                turn_id: "turn_1".to_string(),
                started_at_ms: 0,
                command: vec!["bash".to_string(), "-lc".to_string(), "ls".to_string()],
                cwd: cwd.clone().into(),
                parsed_cmd: Vec::new(),
                source: ExecCommandSource::Agent,
                interaction_input: None,
            }),
        });
        assert_eq!(started.len(), 1);
        assert_eq!(started[0]["type"], "item.started");
        assert_eq!(started[0]["item"]["command"], "bash -lc ls");

        let updated = adapter.collect(&Event {
            id: "evt_delta".to_string(),
            msg: EventMsg::ExecCommandOutputDelta(ExecCommandOutputDeltaEvent {
                call_id: "call_1".to_string(),
                stream: ExecOutputStream::Stdout,
                chunk: b"README.md\n".to_vec(),
            }),
        });
        assert!(updated.is_empty());

        let completed = adapter.collect(&Event {
            id: "evt_end".to_string(),
            msg: EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                call_id: "call_1".to_string(),
                process_id: None,
                turn_id: "turn_1".to_string(),
                completed_at_ms: 0,
                command: vec!["bash".to_string(), "-lc".to_string(), "ls".to_string()],
                cwd: cwd.into(),
                parsed_cmd: Vec::new(),
                source: ExecCommandSource::Agent,
                interaction_input: None,
                stdout: "README.md\n".to_string(),
                stderr: String::new(),
                aggregated_output: "README.md\n".to_string(),
                exit_code: 0,
                duration: Duration::from_millis(25),
                formatted_output: "README.md".to_string(),
                status: ExecCommandStatus::Completed,
            }),
        });
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["type"], "item.completed");
        assert_eq!(completed[0]["item"]["status"], "completed");
        assert_eq!(completed[0]["item"]["exit_code"], 0);
        assert_eq!(completed[0]["item"]["aggregated_output"], "README.md\n");
    }

    #[test]
    fn codex_event_stream_projects_only_redacted_terminal_shared_browser_consent() {
        let mut adapter = CodexEventStreamAdapter::default();
        let event = |server: &str| Event {
            id: "evt_mcp_end".to_string(),
            msg: EventMsg::McpToolCallEnd(McpToolCallEndEvent {
                call_id: "call_terminal_consent".to_string(),
                invocation: McpInvocation {
                    server: server.to_string(),
                    tool: "click".to_string(),
                    arguments: None,
                },
                connector_id: None,
                mcp_app_resource_uri: None,
                link_id: None,
                app_name: None,
                action_name: None,
                plugin_id: None,
                duration: Duration::from_millis(1),
                result: Ok(CallToolResult {
                    content: vec![json!({
                        "type": "text",
                        "text": "raw approval details must not be projected",
                    })],
                    structured_content: Some(json!({
                        "terminalConsent": {
                            "state": "blocked",
                            "terminal": true,
                            "retryable": false,
                            "code": "approval_denied",
                        },
                        "rawDetails": "must not cross the adapter boundary",
                    })),
                    is_error: Some(true),
                    meta: None,
                }),
            }),
        };

        let projected = adapter.collect(&event("instafy_shared_browser"));
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0]["item"]["status"], "failed");
        assert_eq!(
            projected[0]["item"]["terminalConsent"]["code"],
            "approval_denied"
        );
        assert!(projected[0]["item"].get("rawDetails").is_none());

        let unrelated = adapter.collect(&event("untrusted_server"));
        assert!(unrelated[0]["item"].get("terminalConsent").is_none());
    }

    #[test]
    fn codex_event_stream_adapter_compacts_command_output() {
        let mut adapter = CodexEventStreamAdapter::default();
        let cwd =
            AbsolutePathBuf::from_absolute_path(Path::new("/tmp")).expect("absolute /tmp path");

        let _ = adapter.collect(&Event {
            id: "evt_begin".to_string(),
            msg: EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                call_id: "call_1".to_string(),
                process_id: None,
                turn_id: "turn_1".to_string(),
                started_at_ms: 0,
                command: vec!["bash".to_string(), "-lc".to_string(), "cat big".to_string()],
                cwd: cwd.clone().into(),
                parsed_cmd: Vec::new(),
                source: ExecCommandSource::Agent,
                interaction_input: None,
            }),
        });
        let _ = adapter.collect(&Event {
            id: "evt_delta".to_string(),
            msg: EventMsg::ExecCommandOutputDelta(ExecCommandOutputDeltaEvent {
                call_id: "call_1".to_string(),
                stream: ExecOutputStream::Stdout,
                chunk: "a"
                    .repeat(MAX_COMMAND_OUTPUT_BUFFER_CHARS + 128)
                    .into_bytes(),
            }),
        });

        let completed = adapter.collect(&Event {
            id: "evt_end".to_string(),
            msg: EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                call_id: "call_1".to_string(),
                process_id: None,
                turn_id: "turn_1".to_string(),
                completed_at_ms: 0,
                command: vec!["bash".to_string(), "-lc".to_string(), "cat big".to_string()],
                cwd: cwd.into(),
                parsed_cmd: Vec::new(),
                source: ExecCommandSource::Agent,
                interaction_input: None,
                stdout: String::new(),
                stderr: String::new(),
                aggregated_output: String::new(),
                exit_code: 0,
                duration: Duration::from_millis(25),
                formatted_output: String::new(),
                status: ExecCommandStatus::Completed,
            }),
        });

        let output = completed[0]["item"]["aggregated_output"]
            .as_str()
            .expect("aggregated output");
        assert!(output.starts_with("[command output truncated; keeping tail]"));
        assert!(output.chars().count() < MAX_COMMAND_OUTPUT_BUFFER_CHARS);
    }

    #[test]
    fn compact_command_output_redacts_shell_snapshot_output() {
        let output = compact_command_output_for_event(
            "=== .codex-runtime-fallback/shell_snapshots/snapshot.sh ===\nexport TOKEN=value",
        );
        assert_eq!(output, "[runtime-local shell snapshot output omitted]");
    }

    #[test]
    fn codex_event_stream_adapter_completes_content_agent_message_deltas() {
        let mut adapter = CodexEventStreamAdapter::default();

        let updated = adapter.collect(&Event {
            id: "evt_delta_1".to_string(),
            msg: EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent {
                thread_id: "thread_1".to_string(),
                turn_id: "turn_1".to_string(),
                item_id: "item_agent_1".to_string(),
                delta: "{\"summary\":\"ok".to_string(),
            }),
        });
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0]["type"], "item.updated");
        assert_eq!(updated[0]["item"]["id"], "item_agent_1");

        let updated = adapter.collect(&Event {
            id: "evt_delta_2".to_string(),
            msg: EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent {
                thread_id: "thread_1".to_string(),
                turn_id: "turn_1".to_string(),
                item_id: "item_agent_1".to_string(),
                delta: "-from-content-delta\",\"files\":[]}".to_string(),
            }),
        });
        assert_eq!(
            updated[0]["item"]["text"],
            "{\"summary\":\"ok-from-content-delta\",\"files\":[]}"
        );

        let completed = adapter.collect(&Event {
            id: "evt_turn_complete".to_string(),
            msg: EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: "turn_1".to_string(),
                last_agent_message: None,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        });
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["type"], "item.completed");
        assert_eq!(completed[0]["item"]["id"], "item_agent_1");
        assert_eq!(
            latest_completed_agent_message_from_events(&completed),
            Some("{\"summary\":\"ok-from-content-delta\",\"files\":[]}")
        );
    }

    #[test]
    fn codex_event_stream_adapter_collects_completed_agent_message_items() {
        let mut adapter = CodexEventStreamAdapter::default();

        let completed = adapter.collect(&Event {
            id: "evt_item_completed".to_string(),
            msg: EventMsg::ItemCompleted(ItemCompletedEvent {
                thread_id: ThreadId::new(),
                turn_id: "turn_1".to_string(),
                item: TurnItem::AgentMessage(codex_protocol::items::AgentMessageItem {
                    id: "agent_message_1".to_string(),
                    content: vec![AgentMessageContent::Text {
                        text: "{\"summary\":\"ok-from-item\",\"files\":[]}".to_string(),
                    }],
                    phase: None,
                    memory_citation: None,
                }),
                completed_at_ms: 0,
            }),
        });

        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["type"], "item.completed");
        assert_eq!(completed[0]["item"]["id"], "agent_message_1");
        assert_eq!(completed[0]["item"]["type"], "agent_message");
        assert_eq!(
            latest_completed_agent_message_from_events(&completed),
            Some("{\"summary\":\"ok-from-item\",\"files\":[]}")
        );

        let turn_complete = adapter.collect(&Event {
            id: "evt_turn_complete".to_string(),
            msg: EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: "turn_1".to_string(),
                last_agent_message: None,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        });
        assert!(turn_complete.is_empty());
    }

    #[test]
    fn completed_commentary_agent_messages_are_not_final_candidates() {
        let mut adapter = CodexEventStreamAdapter::default();

        let completed = adapter.collect(&Event {
            id: "evt_item_completed".to_string(),
            msg: EventMsg::ItemCompleted(ItemCompletedEvent {
                thread_id: ThreadId::new(),
                turn_id: "turn_1".to_string(),
                item: TurnItem::AgentMessage(codex_protocol::items::AgentMessageItem {
                    id: "agent_message_1".to_string(),
                    content: vec![AgentMessageContent::Text {
                        text: "I am checking the project files.".to_string(),
                    }],
                    phase: Some(MessagePhase::Commentary),
                    memory_citation: None,
                }),
                completed_at_ms: 0,
            }),
        });

        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["type"], "item.completed");
        assert_eq!(completed[0]["item"]["type"], "agent_message");
        assert_eq!(completed[0]["item"]["phase"], "commentary");
        assert_eq!(latest_completed_agent_message_from_events(&completed), None);
        assert_eq!(
            final_agent_message_text_from_turn_item(&TurnItem::AgentMessage(
                codex_protocol::items::AgentMessageItem {
                    id: "agent_message_2".to_string(),
                    content: vec![AgentMessageContent::Text {
                        text: "still checking".to_string(),
                    }],
                    phase: Some(MessagePhase::Commentary),
                    memory_citation: None,
                },
            )),
            None
        );
    }

    #[test]
    fn commentary_agent_message_events_are_trace_only() {
        let mut adapter = CodexEventStreamAdapter::default();

        let completed = adapter.collect(&Event {
            id: "evt_agent_message".to_string(),
            msg: EventMsg::AgentMessage(AgentMessageEvent {
                message: "I am checking the project files.".to_string(),
                phase: Some(MessagePhase::Commentary),
                memory_citation: None,
            }),
        });

        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["type"], "item.completed");
        assert_eq!(completed[0]["item"]["phase"], "commentary");
        assert_eq!(latest_completed_agent_message_from_events(&completed), None);
        assert_eq!(
            agent_message_event_text(&AgentMessageEvent {
                message: "I am checking the project files.".to_string(),
                phase: Some(MessagePhase::Commentary),
                memory_citation: None,
            }),
            None
        );
    }

    #[test]
    fn codex_event_stream_adapter_collects_raw_assistant_response_items() {
        let mut adapter = CodexEventStreamAdapter::default();

        let completed = adapter.collect(&Event {
            id: "evt_raw_response_item".to_string(),
            msg: EventMsg::RawResponseItem(RawResponseItemEvent {
                item: ResponseItem::Message {
                    id: Some(codex_protocol::ResponseItemId::from_server(
                        "msg_1".to_string(),
                    )),
                    role: "assistant".to_string(),
                    content: vec![ContentItem::OutputText {
                        text: "{\"summary\":\"ok-from-raw\",\"files\":[]}".to_string(),
                    }],
                    phase: Some(MessagePhase::FinalAnswer),
                    internal_chat_message_metadata_passthrough: None,
                },
            }),
        });

        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["type"], "item.completed");
        assert_eq!(completed[0]["item"]["type"], "agent_message");
        assert_eq!(
            latest_completed_agent_message_from_events(&completed),
            Some("{\"summary\":\"ok-from-raw\",\"files\":[]}")
        );

        let turn_complete = adapter.collect(&Event {
            id: "evt_turn_complete".to_string(),
            msg: EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: "turn_1".to_string(),
                last_agent_message: None,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        });
        assert!(turn_complete.is_empty());
    }

    #[test]
    fn assistant_response_item_text_ignores_raw_commentary_items() {
        let item = ResponseItem::Message {
            id: Some(codex_protocol::ResponseItemId::from_server(
                "msg_1".to_string(),
            )),
            role: "assistant".to_string(),
            content: vec![ContentItem::OutputText {
                text: "working".to_string(),
            }],
            phase: Some(MessagePhase::Commentary),
            internal_chat_message_metadata_passthrough: None,
        };

        assert_eq!(assistant_response_item_text(&item), None);
    }

    #[test]
    fn unstructured_turn_complete_text_is_retained_as_invalid_final_candidate() {
        assert!(is_unstructured_turn_complete_candidate(
            true,
            false,
            "Plain text final answer."
        ));
        assert!(!is_unstructured_turn_complete_candidate(
            true,
            false,
            "{\"summary\":\"ok\",\"files\":[]}"
        ));
        assert!(!is_unstructured_turn_complete_candidate(
            true,
            true,
            "Plain text final answer."
        ));
        assert!(!is_unstructured_turn_complete_candidate(
            false,
            false,
            "Plain text final answer."
        ));
    }

    #[test]
    fn codex_event_stream_adapter_emits_turn_usage_after_token_count() {
        let mut adapter = CodexEventStreamAdapter::default();
        let token_usage = TokenUsage {
            input_tokens: 1000,
            cached_input_tokens: 200,
            cache_write_input_tokens: 0,
            output_tokens: 250,
            reasoning_output_tokens: 50,
            total_tokens: 1250,
        };
        let _ = adapter.collect(&Event {
            id: "evt_tokens".to_string(),
            msg: EventMsg::TokenCount(TokenCountEvent {
                info: Some(TokenUsageInfo {
                    total_token_usage: token_usage.clone(),
                    last_token_usage: token_usage.clone(),
                    model_context_window: Some(128_000),
                }),
                rate_limits: None,
            }),
        });

        let completed = adapter.collect(&Event {
            id: "evt_turn_complete".to_string(),
            msg: EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: "turn_1".to_string(),
                last_agent_message: None,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        });

        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["type"], "turn.completed");
        assert_eq!(completed[0]["usage"]["input_tokens"], 1000);
        assert_eq!(completed[0]["usage"]["cached_input_tokens"], 200);
        assert_eq!(completed[0]["usage"]["output_tokens"], 250);
    }
}

fn resolve_sandbox_mode() -> SandboxMode {
    SandboxMode::DangerFullAccess
}
