//! A turn the person stops keeps what it changed before it learned of the
//! stop, and its chat says so.
//!
//! A Stop cancels the job on the controller at once. The turn learns of it at
//! its next heartbeat, a second later at most, or when the controller refuses
//! one of its reports, and a step the model sent before then has run: an edit
//! is in the folder, and the job's own save at its end keeps it
//! (`rolling_saves`). A turn that lost its lease sends no completion, so
//! nothing recorded the edit: no row in Details, no Undo, and the card kept its
//! picture of the page as it was.
//!
//! So a turn that saves to the workspace records how its folder began
//! ([`TurnStart`]), and when it loses its lease, the paths whose `git status`
//! changed since go with its error ([`StoppedTurnChanges`]). The job loop then
//! sends the controller one end report of them
//! ([`JobProcessor::report_stopped_turn`]): the step that names the edit, as a
//! finished turn's step does, and the files, as a finished turn's reply lists
//! them. The controller takes it only from the runtime that held the job,
//! once, for a job it cancelled moments before, and only to record it: the
//! job stays cancelled and its charge stays as the Stop left it. The turn's
//! line then names the edit, with Review changes and Undo, and the previews
//! whose sites it changed are pictured again.
//!
//! A job whose lease was lost to a stop of this runtime is back in the queue,
//! not cancelled: the controller turns its report down, and the job's next
//! lease takes the work up as before (`turn_baseline`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{Value as JsonValue, json};
use tracing::info;

use super::preview_pictures::PictureRetake;
use super::{CodexFileDescriptor, GitStatusEntry, JobExecution, JobMessage, JobProcessor};
use crate::controller::{ControllerClient, LeaseJob, MAX_AGENT_METADATA_ARRAY_ITEMS, Registration};

/// The step's id in its turn: one per stopped turn.
const STOPPED_TURN_STEP_ID: &str = "stopped-turn-files";

/// How a turn's folder began, for what the turn changed should it lose its
/// lease. Set once the turn has taken the folder's `git status`.
#[derive(Default)]
pub(super) struct TurnStart(Mutex<Option<(PathBuf, HashMap<String, GitStatusEntry>)>>);

impl TurnStart {
    pub(super) fn record(&self, workspace_dir: &Path, status: &HashMap<String, GitStatusEntry>) {
        *self.0.lock() = Some((workspace_dir.to_path_buf(), status.clone()));
    }

    /// `result`, with what the turn changed in its folder on the error when
    /// it lost its lease and changed something.
    pub(super) async fn attach_to_lost_lease(
        &self,
        result: Result<JobExecution>,
    ) -> Result<JobExecution> {
        let error = match result {
            Err(error) if crate::agent_executor::is_lease_lost(&error) => error,
            other => return other,
        };
        let Some((workspace_dir, before)) = self.0.lock().take() else {
            return Err(error);
        };
        let Some(after) = super::collect_git_status_porcelain(&workspace_dir).await else {
            return Err(error);
        };
        let files = super::status_delta_files_for_checkpoint(&before, &after, &[]);
        if files.is_empty() {
            return Err(error);
        }
        Err(error.context(StoppedTurnChanges {
            workspace_dir,
            files,
        }))
    }
}

/// What a turn that lost its lease changed in its folder: the paths whose
/// `git status` changed during the turn, as its checkpoint would have saved
/// them.
#[derive(Debug)]
pub(crate) struct StoppedTurnChanges {
    workspace_dir: PathBuf,
    files: Vec<CodexFileDescriptor>,
}

impl std::fmt::Display for StoppedTurnChanges {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "the turn changed {} file(s) before it stopped",
            self.files.len()
        )
    }
}

impl StoppedTurnChanges {
    /// The files the report names, at most as many as a report carries.
    fn listed(&self) -> &[CodexFileDescriptor] {
        &self.files[..self.files.len().min(MAX_AGENT_METADATA_ARRAY_ITEMS)]
    }

    /// The end report: the step that names the edit, as a finished turn
    /// streams it, and the `apply/files` artifact a finished turn's reply
    /// carries.
    fn report(&self, runtime_id: &uuid::Uuid) -> (JobMessage, Vec<JsonValue>) {
        let files = self.listed();
        let paths: Vec<String> = files
            .iter()
            .map(|file| file.workspace_path.clone())
            .collect();
        let mut metadata = json!({
            "kind": "codex_file_change",
            "itemId": STOPPED_TURN_STEP_ID,
            "eventType": "item.completed",
            "status": "completed",
            "paths": paths,
        });
        if let Some(activity) = super::activity_labels::file_change_activity(paths.len()) {
            metadata["activity"] = activity;
        }
        let step = super::with_runtime_metadata(
            JobMessage {
                content: format!("Applied file changes: {}", paths.join(", ")),
                message_type: Some("file_change".to_string()),
                metadata: Some(metadata),
            },
            runtime_id,
        );
        let artifacts = vec![json!({
            "kind": "apply/files",
            "files": files.iter().map(super::apply_files_entry).collect::<Vec<_>>(),
            "metadata": { "provider": "codex-embedded" },
        })];
        (step, artifacts)
    }
}

impl JobProcessor {
    /// After a job's turn lost its lease: what the turn changed, when it
    /// changed anything (`error` carries [`StoppedTurnChanges`]), goes to the
    /// controller in one end report. A Stop cancelled the job, and the
    /// controller records the report on its turn; the job then ended here,
    /// and the previews whose sites it changed are pictured again. A job a
    /// stop of this runtime put back in the queue is turned down, and keeps
    /// its record of how its turn began for its next lease.
    pub async fn report_stopped_turn(
        &self,
        client: &ControllerClient,
        registration: &Registration,
        job: &LeaseJob,
        error: &anyhow::Error,
    ) {
        let Some(changes) = error.downcast_ref::<StoppedTurnChanges>() else {
            return;
        };
        let (step, artifacts) = changes.report(&registration.runtime_id);
        let metadata = step.metadata.clone().unwrap_or(JsonValue::Null);
        match client
            .report_stopped_turn(
                registration,
                job.id,
                &step.content,
                step.message_type.as_deref().unwrap_or("file_change"),
                &metadata,
                &artifacts,
            )
            .await
        {
            Ok(()) => {
                info!(
                    job_id = %job.id,
                    files = changes.files.len(),
                    "recorded what the stopped turn changed"
                );
                super::turn_baseline::forget(&changes.workspace_dir, job.id);
                if let Ok(project_id) = self.project_id_for_job(job) {
                    PictureRetake::start(
                        &changes.workspace_dir,
                        project_id,
                        false,
                        &changes.files,
                        None,
                        self.picture_sender(),
                    )
                    .detach();
                }
            }
            Err(report_error) => info!(
                job_id = %job.id,
                error = %report_error,
                "the controller recorded nothing of the turn that lost its lease"
            ),
        }
    }
}

#[cfg(test)]
#[path = "stopped_turn_tests.rs"]
mod tests;
