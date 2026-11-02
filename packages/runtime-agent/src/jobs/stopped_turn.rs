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
//! changed since go with its error ([`StoppedTurnChanges`]). The executor that
//! ran the turn then sends the controller one end report of them
//! ([`JobProcessor::report_stopped_turn`]). A Stop can also reach a job after
//! its model is done, while its changes are saved: the controller then refuses
//! the job's completion, and the job loop sends the same report of the files
//! the finished turn's reply would have listed, with its save
//! ([`StoppedTurnChanges::of_finished_turn`]).
//!
//! The report is the turn's step that names the edit, as a finished turn's
//! step does, and the files, as a finished turn's reply lists them. The step
//! names the files by their place in the turn's folder, as the turn's own edit
//! steps do, so the controller can tell which of them the chat already shows.
//! The controller takes the report only from the runtime that held the job,
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
            save: None,
        }))
    }
}

/// What a stopped turn changed in its folder: the paths whose `git status`
/// changed during a turn that lost its lease, as its checkpoint would have
/// saved them, or the files a finished turn's reply lists when the Stop
/// reached it after its model was done.
#[derive(Debug)]
pub(crate) struct StoppedTurnChanges {
    workspace_dir: PathBuf,
    files: Vec<CodexFileDescriptor>,
    /// The turn's own save, as its reply carries it (`origin/apply`), when it
    /// ran before the Stop reached the turn. A turn that lost its lease never
    /// saved: its changes are unsaved work in the folder.
    save: Option<JsonValue>,
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
    /// What a turn that lost its lease changed, when it changed anything.
    pub(crate) fn of_lost_lease(error: &anyhow::Error) -> Option<&Self> {
        error.downcast_ref::<Self>()
    }

    /// What a turn whose model was done changed, from the execution its
    /// completion carried: the files its reply lists (not the ones it only
    /// read), and its save. None when it changed nothing.
    pub(crate) fn of_finished_turn(
        workspace_dir: PathBuf,
        execution: &JobExecution,
    ) -> Option<Self> {
        let of_kind = |kind: &str| {
            execution
                .artifacts
                .iter()
                .rev()
                .find(|artifact| artifact.get("kind").and_then(JsonValue::as_str) == Some(kind))
        };
        let files: Vec<CodexFileDescriptor> = of_kind("apply/files")?
            .get("files")
            .and_then(JsonValue::as_array)?
            .iter()
            .filter_map(super::parse_file_descriptor)
            .filter(|file| !file.is_read_reference())
            .filter_map(|mut file| {
                let relative = super::sanitize_relative_workspace_path(&file.workspace_path)?;
                let relative = relative.to_string_lossy().replace('\\', "/");
                if relative.is_empty() {
                    return None;
                }
                file.path = relative.clone();
                file.workspace_path = relative;
                Some(file)
            })
            .collect();
        if files.is_empty() {
            return None;
        }
        Some(Self {
            workspace_dir,
            files,
            save: of_kind("origin/apply").cloned(),
        })
    }

    /// The files the report names, at most as many as a report carries.
    fn listed(&self) -> &[CodexFileDescriptor] {
        &self.files[..self.files.len().min(MAX_AGENT_METADATA_ARRAY_ITEMS)]
    }

    /// The end report: the step that names the edit, as a finished turn
    /// streams it, and the `apply/files` artifact a finished turn's reply
    /// carries, with the turn's save when it ran one. The step names each
    /// file by its place in the turn's folder, as the turn's own edit steps
    /// do: the controller leaves out of it what those already showed.
    fn report(&self, runtime_id: &uuid::Uuid) -> (JobMessage, Vec<JsonValue>) {
        let files = self.listed();
        let paths: Vec<String> = files
            .iter()
            .map(|file| {
                self.workspace_dir
                    .join(&file.workspace_path)
                    .display()
                    .to_string()
            })
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
        let mut artifact_metadata = json!({ "provider": "codex-embedded" });
        if self.save.is_none() {
            // No save took these: Studio marks them Not saved.
            artifact_metadata["stoppedBeforeSave"] = json!(true);
        }
        let mut artifacts = vec![json!({
            "kind": "apply/files",
            "files": files.iter().map(super::apply_files_entry).collect::<Vec<_>>(),
            "metadata": artifact_metadata,
        })];
        artifacts.extend(self.save.clone());
        (step, artifacts)
    }
}

impl JobProcessor {
    /// The folder `job`'s turn runs in.
    pub(crate) fn workspace_dir_for_job(&self, job: &LeaseJob) -> Option<PathBuf> {
        self.project_id_for_job(job)
            .ok()
            .map(|project_id| self.config.project_workspace_dir(&project_id))
    }

    /// What a stopped turn changed goes to the controller in one end report.
    /// A Stop cancelled the job, and the controller records the report on its
    /// turn; the job then ended here, and the previews whose sites it changed
    /// are pictured again. A job a stop of this runtime put back in the queue
    /// is turned down, and keeps its record of how its turn began for its
    /// next lease. Whether the controller recorded it.
    pub(crate) async fn report_stopped_turn(
        &self,
        client: &ControllerClient,
        registration: &Registration,
        job: &LeaseJob,
        changes: &StoppedTurnChanges,
    ) -> bool {
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
                true
            }
            Err(report_error) => {
                info!(
                    job_id = %job.id,
                    error = %report_error,
                    "the controller recorded nothing of the stopped turn"
                );
                false
            }
        }
    }
}

#[cfg(test)]
#[path = "stopped_turn_tests.rs"]
mod tests;
