use anyhow::Result;
use serde_json::json;
use uuid::Uuid;

use super::workspace_commit::{GitSyncOutcome, git_sync_only};
use super::{JobExecution, JobMessage};

#[derive(Debug, Clone)]
pub struct GitSyncRequest {
    pub message: Option<String>,
}

pub fn parse_git_sync_request(prompt_text: &str) -> Option<GitSyncRequest> {
    let trimmed = prompt_text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_ascii_lowercase();
    let command = if lowered.starts_with("/sync") {
        "/sync"
    } else if lowered.starts_with("/update") {
        "/update"
    } else {
        return None;
    };

    let rest = trimmed.strip_prefix(command).unwrap_or("").trim();
    let message = if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    };

    Some(GitSyncRequest { message })
}

pub async fn build_git_sync_execution(params: GitSyncExecutionParams<'_>) -> Result<JobExecution> {
    let message = params
        .request
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.to_ascii_lowercase().starts_with("instafy:") {
                value.to_string()
            } else {
                format!("instafy: sync ({value})")
            }
        })
        .unwrap_or_else(|| "instafy: sync (user requested update)".to_string());

    let outcome = match git_sync_only(
        params.controller_base_url,
        params.controller_token,
        params.project_id,
        params.runtime_id,
        params.job_id,
        params.run_id,
        &message,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => GitSyncOutcome::Failed {
            message: error.to_string(),
        },
    };

    let (summary, final_messages) = build_messages_from_outcome(&outcome);

    Ok(JobExecution {
        summary,
        suggested_replies: Vec::new(),
        provider: "git-sync".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages,
    })
}

pub struct GitSyncExecutionParams<'a> {
    pub controller_base_url: &'a reqwest::Url,
    pub controller_token: &'a str,
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub job_id: Uuid,
    pub run_id: Option<Uuid>,
    pub request: &'a GitSyncRequest,
}

fn build_messages_from_outcome(outcome: &GitSyncOutcome) -> (String, Vec<JobMessage>) {
    match outcome {
        GitSyncOutcome::NotConfigured => (
            "Git sync skipped: git-canonical remote not configured.".to_string(),
            vec![JobMessage {
                content: "This runtime is not configured with a git-canonical remote, so there’s nothing for me to sync.\n\nIf you meant a user-owned repo (mounted workspace), tell me which remote/branch you want to pull from and I’ll guide you.".to_string(),
                message_type: None,
                metadata: None,
            }],
        ),
        GitSyncOutcome::Synced { rev } => {
            let short_rev = rev
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(8).collect::<String>());

            let first = match short_rev {
                Some(value) => format!("Workspace synced to {value}"),
                None => "Workspace synced".to_string(),
            };

            (
                "Git sync completed.".to_string(),
                vec![JobMessage {
                    content: String::new(),
                    message_type: Some("todo_list".to_string()),
                    metadata: Some(json!({
                        "messageType": "todo_list",
                        "details": {
                            "items": [
                                { "text": first, "completed": true },
                                { "text": "Continue: send what you want to do next", "completed": false }
                            ]
                        }
                    })),
                }],
            )
        }
        GitSyncOutcome::Conflict { message } => (
            "Git sync blocked by conflicts.".to_string(),
            vec![
                JobMessage {
                    content: format!(
                        "Git sync hit conflicts.\n\nOpen `.agents/skills/instafy-git-canonical-conflicts/SKILL.md`, resolve, then run `/sync` again.\n\nDetails:\n{}",
                        message.trim()
                    ),
                    message_type: Some("error".to_string()),
                    metadata: Some(json!({ "messageType": "error" })),
                },
                JobMessage {
                    content: String::new(),
                    message_type: Some("todo_list".to_string()),
                    metadata: Some(json!({
                        "messageType": "todo_list",
                        "details": {
                            "items": [
                                { "text": "Resolve git sync conflicts in the workspace", "completed": false },
                                { "text": "Run /sync again", "completed": false }
                            ]
                        }
                    })),
                },
            ],
        ),
        GitSyncOutcome::Failed { message } => (
            "Git sync failed.".to_string(),
            vec![
                JobMessage {
                    content: format!(
                        "Git sync failed.\n\nTry `/sync` again (it’s safe), or paste the error here and I’ll help troubleshoot.\n\nDetails:\n{}",
                        message.trim()
                    ),
                    message_type: Some("error".to_string()),
                    metadata: Some(json!({ "messageType": "error" })),
                },
                JobMessage {
                    content: String::new(),
                    message_type: Some("todo_list".to_string()),
                    metadata: Some(json!({
                        "messageType": "todo_list",
                        "details": {
                            "items": [
                                { "text": "Retry /sync", "completed": false },
                                { "text": "If it keeps failing, share the error + runtime mode (desktop/hosted)", "completed": false }
                            ]
                        }
                    })),
                },
            ],
        ),
    }
}
