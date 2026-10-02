use anyhow::Result;
use serde_json::json;
use uuid::Uuid;

use super::save_report::append_not_saved;
use super::workspace_commit::{GitSyncOutcome, git_sync_only};
use super::{JobExecution, JobMessage};

/// How to merge files `main` kept its own version of, after a save parked
/// this workspace's version on a recovery ref.
const MERGE_HINT: &str = "\n\nThe saved version kept its own copy of those files. To merge, ask me to merge them: I follow `.agents/skills/instafy-git-canonical-conflicts/SKILL.md`.";
use crate::origin::LocalOriginSync;

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
        params.local_origin.as_ref(),
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
    pub local_origin: Option<LocalOriginSync>,
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
        GitSyncOutcome::Synced { rev, report } => {
            let short_rev = rev
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(8).collect::<String>());

            let first = match short_rev {
                Some(value) => format!("Workspace synced to {value}"),
                None => "Workspace synced".to_string(),
            };

            let mut messages = Vec::new();
            let not_saved = report.not_saved_sentences(&[], None);
            if !not_saved.is_empty() {
                let mut content = String::new();
                append_not_saved(&mut content, &not_saved);
                if !report.conflicted_paths.is_empty() {
                    content.push_str(MERGE_HINT);
                }
                messages.push(JobMessage {
                    content,
                    message_type: None,
                    metadata: None,
                });
            }
            messages.push(JobMessage {
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
            });

            let summary = if not_saved.is_empty() {
                "Git sync completed."
            } else {
                "Git sync completed; some files were not saved."
            };
            (summary.to_string(), messages)
        }
        GitSyncOutcome::NotSaved { message, report } => {
            let mut content = String::new();
            let mut sentences = report.not_saved_sentences(&[], Some(message.as_str()));
            if sentences.is_empty() {
                sentences.push(message.trim().to_string());
            }
            append_not_saved(&mut content, &sentences);
            if !report.conflicted_paths.is_empty() {
                content.push_str(MERGE_HINT);
            } else {
                content.push_str("\n\nNothing was lost: try `/sync` again (it is safe).");
            }
            (
                "Git sync saved nothing.".to_string(),
                vec![
                    JobMessage {
                        content,
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
                                    { "text": "Review the work that was not saved", "completed": false },
                                    { "text": "Run /sync again", "completed": false }
                                ]
                            }
                        })),
                    },
                ],
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::save_report::{RejectedPath, SaveReport};

    #[test]
    fn a_partial_sync_names_what_was_not_saved_and_how_to_merge_it() {
        let (summary, messages) = build_messages_from_outcome(&GitSyncOutcome::Synced {
            rev: Some("0123456789abcdef".to_string()),
            report: SaveReport {
                status: Some("partial".to_string()),
                recovery_ref: Some("refs/instafy/recovery/o/x-conflict-1".to_string()),
                conflicted_paths: vec!["src/app.ts".to_string()],
                rejected_paths: vec![RejectedPath {
                    path: ".env".to_string(),
                    reason: "secret".to_string(),
                    kept_saved_version: false,
                }],
            },
        });
        assert_eq!(summary, "Git sync completed; some files were not saved.");
        assert_eq!(messages.len(), 2);
        assert!(messages[0].content.starts_with(
            "Not saved: src/app.ts (kept at refs/instafy/recovery/o/x-conflict-1).\n\nNot saved: .env (secret files are never saved)."
        ));
        assert!(
            messages[0]
                .content
                .contains("instafy-git-canonical-conflicts")
        );
        assert_eq!(messages[1].message_type.as_deref(), Some("todo_list"));

        let (summary, messages) = build_messages_from_outcome(&GitSyncOutcome::Synced {
            rev: Some("0123456789abcdef".to_string()),
            report: SaveReport::default(),
        });
        assert_eq!(summary, "Git sync completed.");
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn a_sync_that_saved_nothing_says_where_the_work_is_kept() {
        let (summary, messages) = build_messages_from_outcome(&GitSyncOutcome::NotSaved {
            message:
                "Not saved: the saved version kept changing (kept at refs/instafy/local-recovery/x)"
                    .to_string(),
            report: SaveReport {
                status: Some("unpublished".to_string()),
                recovery_ref: Some("refs/instafy/local-recovery/x".to_string()),
                ..SaveReport::default()
            },
        });
        assert_eq!(summary, "Git sync saved nothing.");
        assert!(messages[0].content.starts_with(
            "Not saved: the saved version kept changing (kept at refs/instafy/local-recovery/x)."
        ));
        assert!(messages[0].content.contains("/sync"));
        assert_eq!(messages[0].message_type.as_deref(), Some("error"));
    }
}
