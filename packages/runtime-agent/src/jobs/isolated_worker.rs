//! Parent-owned admission, scoped publication and accounting for native workers.

use super::isolated_workspace::{IsolatedFileChange, IsolatedWorkspace, SnapshotLimits};
use super::*;
use crate::isolated_tool_worker::{
    self, IsolatedToolWorkerFailure, IsolatedToolWorkerRequest, IsolatedWorkerJobConfig,
};
use std::io::Cursor;
use std::time::Duration;

pub(super) struct IsolatedWorkerSettings {
    pub enabled: bool,
    pub(super) proxy_base: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

impl IsolatedWorkerSettings {
    pub fn from_env() -> Self {
        Self {
            enabled: matches!(
                env::var("INSTAFY_EXPERIMENTAL_ISOLATED_TOOL_WORKERS").as_deref(),
                Ok("1" | "true")
            ),
            // Capture immutable launch settings, never another job's temporary credentials.
            proxy_base: env::var("PROXY_BASE_URL")
                .ok()
                .and_then(|value| normalize_direct_worker_proxy_base(&value)),
            // The launch CODEX_MODEL is moved out of the process environment
            // at startup (see `job_model`), so read the captured value.
            model: crate::job_model::launch_model().map(str::to_string),
            reasoning_effort: env::var("CODEX_RUNTIME_REASONING_EFFORT").ok(),
        }
    }

    pub(super) fn resolve(
        &self,
        job: &IsolatedWorkerJobConfig,
        job_effort: Option<ReasoningEffort>,
    ) -> (Option<String>, ReasoningEffort) {
        (
            job.model.clone().or_else(|| self.model.clone()),
            crate::codex::resolve_runtime_reasoning_effort(
                self.reasoning_effort.as_deref(),
                job_effort,
                job.reasoning_effort.clone(),
            ),
        )
    }
}

impl JobProcessor {
    pub(crate) fn can_run_isolated_scoped_worker(
        &self,
        registration: &Registration,
        job: &LeaseJob,
    ) -> bool {
        self.isolated_workers.enabled
            && job.controller_token.as_ref().is_some_and(|token| !token.trim().is_empty())
            && self.parallel_scoped_scope_paths(job).is_some_and(|paths| {
                paths.iter().all(|path| !path.contains('*') && !path.contains('?'))
            })
            // Attachments live outside the snapshot's published source tree. They,
            // browser/MCP work and unbounded scopes are outside this experimental lane.
            && !isolated_worker_has_attachments(&job.payload)
            && !runtime_job_expectations(&job.payload).generic_mcp_tool_execution
            && !crate::personal_browser::payload_requests_personal_browser(&job.payload)
            && !crate::shared_browser::payload_requests_shared_browser(&job.payload)
            && job.proxy.as_ref().or(registration.proxy.as_ref()).is_some_and(|proxy| {
                !proxy.token.trim().is_empty()
                    && normalize_direct_worker_proxy_base(&proxy.url).is_some()
            })
    }

    pub async fn run_isolated_scoped_worker_job(
        &self,
        registration: &Registration,
        job: &LeaseJob,
        progress: Option<JobProgress>,
        cancel_signal: Option<JobCancelSignal>,
        worker_config: IsolatedWorkerJobConfig,
    ) -> Result<JobExecution> {
        let cancel = cancel_signal.unwrap_or_default();
        ensure_worker_running(&cancel)?;
        // Scope checks precede all project reads, including preferences and snapshots.
        self.verified_controller_claims(registration, job)
            .await?
            .context("isolated worker requires a verified controller token before project reads")?;
        anyhow::ensure!(
            self.can_run_isolated_scoped_worker(registration, job),
            "job is not eligible for the experimental isolated worker lane"
        );
        let project_id = self.project_id_for_job(job)?;
        let workspace_dir = self.prepare_workspace(&project_id)?;
        let owned = direct_owned_write_scopes(&workspace_dir, job)
            .context("isolated worker is missing owned paths")?;
        let read_only = extract_scoped_worker_read_only_paths(job);
        let prompt_text = job
            .payload
            .get("prompt_text")
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        let context_cards = self
            .load_relevant_project_context_cards(job, project_id, prompt_text)
            .await;
        let (mut prompt, _, mut prompt_context, _attachments, _) = self
            .build_turn_prompt(
                &project_id,
                job,
                &workspace_dir,
                prompt_text,
                None,
                &context_cards,
                None,
                None,
                &ProjectPreferencesSnapshot::load(&workspace_dir),
                0,
            )
            .await?;
        annotate_prompt_context_final_output_mode(
            &mut prompt_context,
            RuntimeFinalOutputMode::StrictStructured,
        );
        // Serialize the short copy/apply phases only; model calls and commands overlap.
        let snapshot = {
            let _apply = self.isolated_apply.lock().await;
            let source = workspace_dir.clone();
            let snapshot_cancel = cancel.clone();
            tokio::task::spawn_blocking(move || {
                let _workspace = lock_isolated_workspace(&source)?;
                ensure_worker_running(&snapshot_cancel)?;
                IsolatedWorkspace::snapshot(&source, SnapshotLimits::default())
            })
            .await
            .context("snapshot task failed")??
        };
        prompt.push_str("\nExecution environment: you have a private source snapshot. Use real tools for observations and commands; edit files on disk and finish with the scoped worker JSON response contract. For a necessary human decision, return the request_user_input action before attempting blocked edits or commands. Only your declared owned paths may change. Do not start background daemons or additional agents. Git metadata, dependencies, caches and secret files were excluded. If the task requires unavailable inputs or capabilities, explain the limitation; do not claim it was executed. Use relative project paths; the original project directory is not accessible.\n");
        let proxy = job
            .proxy
            .as_ref()
            .or(registration.proxy.as_ref())
            .context("worker proxy missing")?;
        let proxy_base = self
            .isolated_workers
            .proxy_base
            .clone()
            .or_else(|| normalize_direct_worker_proxy_base(&proxy.url))
            .context("worker proxy URL missing")?;
        let (model, reasoning_effort) = self.isolated_workers.resolve(
            &worker_config,
            // A plan worker is not a chat turn, so the managed chat effort
            // never applies to it (and this lane never reads another job's
            // process environment).
            reasoning_effort_for_runtime_job(
                job,
                prompt_text,
                false,
                runtime_job_expectations(&job.payload),
                None,
            ),
        );
        let request = IsolatedToolWorkerRequest {
            workspace_dir: snapshot.workspace_dir().to_owned(),
            state_dir: snapshot.home_dir().to_owned(),
            prompt,
            project_id,
            job_id: job.id,
            conversation_id: job.conversation_id,
            proxy_base_url: proxy_base,
            proxy_token: proxy.token.clone(),
            controller_base_url: self.config.controller_base_url.to_string(),
            // No general controller/MCP tools. Research accounting uses its own
            // narrow capability; publication authority stays here.
            controller_token: None,
            controller_token_scopes: Vec::new(),
            controller_token_expires_at: None,
            job_environment: worker_config.environment,
            research_budget: worker_config.research_budget,
            model,
            reasoning_effort: Some(reasoning_effort),
            // the project's skill-pack folder, shared with its other turns on this runtime
            cache_dir: crate::skill_packs::prepare_skill_pack_cache_dir(
                &self.config.workspace_root,
                &project_id,
            )
            .map_err(|error| warn!(?error, %project_id, "skill pack cache folder unavailable"))
            .ok(),
        };
        let mut streamed_events = Vec::new();
        let mut streamed_count = 0;
        let mut on_event = |event: &JsonValue| -> Result<()> {
            if let Some(progress) = progress.as_ref() {
                streamed_events.push(event.clone());
                if progress.status.load(Ordering::SeqCst) {
                    let messages = with_runtime_metadata_vec(
                        extract_codex_messages(&streamed_events),
                        &registration.runtime_id,
                    );
                    for message in messages.iter().skip(streamed_count) {
                        if progress.sender.send(message.clone()).is_err() {
                            progress.status.store(false, Ordering::SeqCst);
                            break;
                        }
                    }
                    streamed_count = messages.len();
                }
            }
            Ok(())
        };
        let output = match isolated_tool_worker::run(request, &mut on_event, cancel.clone()).await {
            Ok(output) => output,
            Err(error) => {
                let artifacts = error
                    .downcast_ref::<IsolatedToolWorkerFailure>()
                    .and_then(|failure| failure.usage_artifact.clone())
                    .into_iter()
                    .collect();
                return Err(worker_failure(error, artifacts));
            }
        };
        let mut artifacts = vec![
            build_codex_run_log_artifact(
                &output.events,
                Some(json!({"runtimeId":registration.runtime_id})),
            ),
            build_codex_prompt_context_artifact(&prompt_context, None),
            json!({"kind":"ai/isolated-tool-worker", "metadata":{
                "ownedPaths":owned.iter().map(|scope| &scope.display_path).collect::<Vec<_>>(),
                "excludedPaths":snapshot.excluded_paths(),
            }}),
        ];
        if let Some(usage) = output.usage_artifact {
            artifacts.push(usage);
        }
        // Every post-model failure retains usage. A conflict never triggers a new model call.
        let publication: Result<JobExecution> = async {
            ensure_worker_running(&cancel)?;
            let outcome = extract_codex_outcome(&output.final_json)?;
            anyhow::ensure!(
                classify_internal_codex_fallback_summary(&outcome.summary).is_none(),
                "isolated worker did not produce a completed final response"
            );
            let changes = snapshot.collect_changes(|path| {
                isolated_worker_owns_path(&owned, &read_only, &workspace_dir, path)
            })?;
            validate_worker_evidence(
                job,
                &outcome,
                isolated_worker_observed_command(&output.events),
                !changes.is_empty(),
            )?;
            // Verify publication authority before touching source files. Token
            // verification failures remain inside the usage-preserving result.
            let workspace_token = self.verified_workspace_token(registration, job).await?;
            anyhow::ensure!(
                changes.is_empty() || workspace_token.is_some(),
                "isolated worker has no verified workspace publication token"
            );
            ensure_worker_running(&cancel)?;
            let files = isolated_change_descriptors(&changes);
            let mut execution_artifacts = artifacts.clone();
            user_input_request::append_outcome_artifact(&mut execution_artifacts, &outcome);
            execution_artifacts.push(
                json!({"kind":"apply/files", "files":files.iter().map(|file| json!({
                "path":file.path, "workspacePath":file.workspace_path,
                "change":file.change.as_ref().map(|change| &change.raw),
            })).collect::<Vec<_>>()}),
            );
            let messages = with_runtime_metadata_vec(
                extract_codex_messages(&output.events),
                &registration.runtime_id,
            );
            let mut execution = JobExecution {
                summary: outcome.summary,
                suggested_replies: Vec::new(),
                provider: "codex-embedded".into(),
                artifacts: execution_artifacts,
                credit_snapshot: None,
                provider_conversation_state: None,
                messages,
                messages_streamed: progress
                    .as_ref()
                    .is_some_and(|progress| progress.status.load(Ordering::SeqCst)),
                final_messages: Vec::new(),
            };
            if changes.is_empty() {
                return Ok(execution);
            }
            let checkpoint = workspace_commit::LaneCheckpoint {
                lane: WRITE_SCOPED_WORKER_LANE,
                commit_to_workspace: true,
                read_only_workspace: false,
                controller_base_url: &self.config.controller_base_url,
                workspace_token: workspace_token.as_deref(),
                project_id,
                runtime_id: registration.runtime_id,
                job_id: job.id,
                run_id: job.run_id,
                workspace_dir: &workspace_dir,
                auto_sync_after_apply_override: None,
                progress_sender: progress.as_ref().map(|progress| progress.sender.clone()),
                local_origin: self.local_origin_sync(),
            };
            let apply_workspace = workspace_dir.clone();
            let publication = workspace_commit::checkpoint_isolated_scope(
                checkpoint,
                changes.iter().map(|change| change.path.clone()).collect(),
                move || {
                    let owns = |path: &str| {
                        isolated_worker_owns_path(&owned, &read_only, &apply_workspace, path)
                    };
                    commit_isolated_changes(&snapshot, &changes, &cancel, &apply_workspace, owns)
                },
            )
            .await?;
            if let Some(progress) = progress.as_ref() {
                let _ = progress
                    .sender
                    .send(workspace_commit_progress_message(&publication));
            }
            execution.artifacts.push(origin_apply_artifact(
                &publication,
                Some(WRITE_SCOPED_WORKER_LANE),
            ));
            save_report::append_not_saved(
                &mut execution.summary,
                &publication.not_saved_sentences(),
            );
            Ok(execution)
        }
        .await;
        publication.map_err(|error| worker_failure(error, artifacts))
    }
}

pub(super) fn validate_worker_evidence(
    job: &LeaseJob,
    outcome: &CodexOutcome,
    observed_command: bool,
    changed_files: bool,
) -> Result<()> {
    user_input_request::validate_outcome_scope(job, outcome)?;
    let requirements = runtime_job_expectations(&job.payload);
    let deferred_for_input = outcome
        .actions
        .iter()
        .any(|action| matches!(action, CodexAction::RequestUserInput(_)));
    anyhow::ensure!(
        !(requirements.command_execution || scoped_worker_requires_tools(job))
            || deferred_for_input
            || observed_command,
        "isolated worker did not execute the required native command"
    );
    anyhow::ensure!(
        !requirements.workspace_file_changes || deferred_for_input || changed_files,
        "isolated worker produced no required file changes"
    );
    Ok(())
}

fn ensure_worker_running(cancel: &JobCancelSignal) -> Result<()> {
    anyhow::ensure!(
        !cancel.is_canceled(),
        "lease lost during isolated worker execution"
    );
    Ok(())
}

fn lock_isolated_workspace(workspace: &Path) -> Result<origin_http_server::WorkspaceApplyLock> {
    origin_http_server::acquire_workspace_apply_lock_within(workspace, Duration::from_secs(10))?
        .context("workspace is busy applying changes")
}

pub(super) fn commit_isolated_changes(
    snapshot: &IsolatedWorkspace,
    changes: &[IsolatedFileChange],
    cancel: &JobCancelSignal,
    workspace: &Path,
    owns: impl Fn(&str) -> bool,
) -> Result<workspace_commit::IsolatedScopeCommit> {
    let _workspace = lock_isolated_workspace(workspace)?;
    ensure_worker_running(cancel)?;
    snapshot.validate_source_unchanged(owns, changes)?;
    apply_isolated_changes(snapshot, changes, cancel, workspace)
}

fn worker_failure(error: anyhow::Error, artifacts: Vec<JsonValue>) -> anyhow::Error {
    let message = error.to_string();
    error.context(JobFailureWithArtifacts { message, artifacts })
}

/// A native terminal receipt proves execution, not the command's correctness.
/// Assistant prose, model-returned file descriptors and a started-only command
/// cannot satisfy this gate. A nonzero completed exit is still a real execution
/// and remains visible in the preserved run log.
fn isolated_worker_observed_command(events: &[JsonValue]) -> bool {
    events.iter().any(|event| {
        event.get("type").and_then(JsonValue::as_str) == Some("item.completed")
            && event.pointer("/item/type").and_then(JsonValue::as_str) == Some("command_execution")
            && matches!(
                event.pointer("/item/status").and_then(JsonValue::as_str),
                Some("completed" | "failed")
            )
            && event
                .pointer("/item/exit_code")
                .and_then(JsonValue::as_i64)
                .is_some()
    })
}

fn isolated_worker_has_attachments(value: &JsonValue) -> bool {
    match value {
        JsonValue::Object(map) => map.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "attachments" | "attachment_downloads" | "attachmentDownloads"
            ) && value.as_array().is_some_and(|items| !items.is_empty())
                || isolated_worker_has_attachments(value)
        }),
        JsonValue::Array(items) => items.iter().any(isolated_worker_has_attachments),
        _ => false,
    }
}

fn isolated_worker_owns_path(
    owned: &[DirectOwnedWriteScope],
    read_only: &[String],
    workspace: &Path,
    path: &str,
) -> bool {
    owned
        .iter()
        .any(|scope| scope.resolve_returned_path(workspace, path).is_some())
        && !read_only
            .iter()
            .any(|scope| codex_write_scope_path_overlaps(scope, path))
}

fn apply_isolated_changes(
    snapshot: &IsolatedWorkspace,
    changes: &[IsolatedFileChange],
    cancel: &JobCancelSignal,
    workspace: &Path,
) -> Result<workspace_commit::IsolatedScopeCommit> {
    apply_isolated_changes_with(
        snapshot,
        changes,
        || ensure_worker_running(cancel),
        |change| write_isolated_change(snapshot.source_handle(), change),
        || {
            let base_rev = origin_http_server::git::head_rev(workspace, None);
            let applied = changes
                .iter()
                .filter(|change| change.contents.is_some())
                .map(|change| change.path.clone())
                .collect::<Vec<_>>();
            let deleted = changes
                .iter()
                .filter(|change| change.contents.is_none())
                .map(|change| change.path.clone())
                .collect::<Vec<_>>();
            let rev = origin_http_server::git::commit_visible_paths_locally(
                workspace,
                &applied,
                &deleted,
                "instafy: isolated worker changes",
            )?;
            Ok(workspace_commit::IsolatedScopeCommit {
                base_rev: base_rev.filter(|base| Some(base) != rev.as_ref()),
                rev,
            })
        },
    )
}

fn apply_isolated_changes_with<T>(
    snapshot: &IsolatedWorkspace,
    changes: &[IsolatedFileChange],
    still_running: impl Fn() -> Result<()>,
    mut write: impl FnMut(&IsolatedFileChange) -> Result<()>,
    finish: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let originals = snapshot.source_versions(changes)?;
    let mut attempted = 0;
    let result = (|| {
        for change in changes {
            still_running()?;
            // Even a write reporting failure may have renamed its file before
            // a later fsync failed. Include that target in the rollback set.
            attempted += 1;
            write(change).with_context(|| format!("apply isolated worker file {}", change.path))?;
        }
        still_running()?;
        finish()
    })();
    let error = match result {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    {
        let mut rollback_errors = Vec::new();
        for original in originals[..attempted].iter().rev() {
            if let Err(restore_error) = write_isolated_change(snapshot.source_handle(), original) {
                rollback_errors.push(format!("{}: {restore_error:#}", original.path));
            }
        }
        if !rollback_errors.is_empty() {
            anyhow::bail!(
                "{error:#}; rollback incomplete; source files require recovery: {}",
                rollback_errors.join("; ")
            );
        }
        Err(error.context("isolated worker apply failed; original file contents restored"))
    }
}

fn write_isolated_change(
    root: &origin_http_server::workspace_fs::WorkspaceDir,
    change: &IsolatedFileChange,
) -> Result<()> {
    match &change.contents {
        Some(bytes) => {
            root.replace_file(&change.path, &mut Cursor::new(bytes), change.executable)?;
        }
        None => match root.remove_file(&change.path) {
            Ok(()) => {}
            // Restoring an originally absent target is already complete if the
            // failed write never created it.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        },
    }
    Ok(())
}

fn isolated_change_descriptors(changes: &[IsolatedFileChange]) -> Vec<CodexFileDescriptor> {
    changes
        .iter()
        .map(|change| CodexFileDescriptor {
            path: change.path.clone(),
            workspace_path: change.path.clone(),
            label: None,
            description: None,
            mime_type: None,
            content: None,
            content_base64: None,
            change: FileChangeDescriptor::parse(
                json!({"type":if change.contents.is_none() { "deleted" } else { "changed" }}),
            ),
        })
        .collect()
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn scoped_worker_model_and_effort_follow_agent_runtime_job_precedence() {
        let mut runtime = IsolatedWorkerSettings {
            enabled: true,
            proxy_base: None,
            model: Some("runtime-model".into()),
            reasoning_effort: Some("max".into()),
        };
        let agent = IsolatedWorkerJobConfig {
            model: Some("agent-model".into()),
            reasoning_effort: Some(ReasoningEffort::Low),
            ..Default::default()
        };
        assert_eq!(
            runtime.resolve(&agent, Some(ReasoningEffort::High)),
            (Some("agent-model".into()), ReasoningEffort::Low)
        );
        let inherited = IsolatedWorkerJobConfig::default();
        assert_eq!(
            runtime.resolve(&inherited, Some(ReasoningEffort::High)),
            (Some("runtime-model".into()), ReasoningEffort::Max)
        );
        runtime.reasoning_effort = None;
        assert_eq!(
            runtime.resolve(&inherited, Some(ReasoningEffort::High)).1,
            ReasoningEffort::High
        );
        runtime.reasoning_effort = Some("misspelled".into());
        assert_eq!(
            runtime.resolve(&inherited, Some(ReasoningEffort::High)).1,
            ReasoningEffort::High
        );
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use tempfile::TempDir;

    fn change(path: &str, contents: Option<&[u8]>) -> IsolatedFileChange {
        IsolatedFileChange {
            path: path.into(),
            contents: contents.map(ToOwned::to_owned),
            executable: false,
        }
    }

    #[test]
    fn concurrent_origin_save_finishes_before_conflict_validation() {
        let source = TempDir::new().unwrap();
        fs::write(source.path().join("owned.txt"), b"original").unwrap();
        let snapshot =
            IsolatedWorkspace::snapshot(source.path(), SnapshotLimits::default()).unwrap();
        // This is the same cross-process guard held by origin /apply. A
        // pending save changes the file while the isolated worker is waiting.
        let saving = lock_isolated_workspace(source.path()).unwrap();
        let workspace = source.path().to_owned();
        let (started, ready) = std::sync::mpsc::channel();
        let (finished, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            let outcome = commit_isolated_changes(
                &snapshot,
                &[change("owned.txt", Some(b"worker"))],
                &JobCancelSignal::new(),
                &workspace,
                |path| path == "owned.txt",
            );
            finished.send(outcome.map(|_| ())).unwrap();
        });
        ready.recv().unwrap();
        assert!(
            result.recv_timeout(Duration::from_millis(100)).is_err(),
            "worker ignored the origin lock"
        );
        fs::write(source.path().join("owned.txt"), b"Studio save").unwrap();
        drop(saving);
        let error = result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err();
        worker.join().unwrap();
        assert!(error.to_string().contains("changed concurrently"));
        assert_eq!(
            fs::read(source.path().join("owned.txt")).unwrap(),
            b"Studio save"
        );
    }

    #[test]
    fn cancellation_while_waiting_for_origin_lock_prevents_apply() {
        let source = TempDir::new().unwrap();
        fs::write(source.path().join("owned.txt"), b"original").unwrap();
        let snapshot =
            IsolatedWorkspace::snapshot(source.path(), SnapshotLimits::default()).unwrap();
        let saving = lock_isolated_workspace(source.path()).unwrap();
        let cancel = JobCancelSignal::new();
        let worker_cancel = cancel.clone();
        let workspace = source.path().to_owned();
        let worker = std::thread::spawn(move || {
            commit_isolated_changes(
                &snapshot,
                &[change("owned.txt", Some(b"worker"))],
                &worker_cancel,
                &workspace,
                |path| path == "owned.txt",
            )
        });
        cancel.cancel();
        drop(saving);
        assert!(
            worker
                .join()
                .unwrap()
                .err()
                .unwrap()
                .to_string()
                .contains("lease lost")
        );
        assert_eq!(
            fs::read(source.path().join("owned.txt")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn failed_scoped_commit_restores_source_before_releasing_lock() {
        let source = TempDir::new().unwrap();
        fs::write(source.path().join("owned.txt"), b"original").unwrap();
        let snapshot =
            IsolatedWorkspace::snapshot(source.path(), SnapshotLimits::default()).unwrap();
        let result: Result<()> = apply_isolated_changes_with(
            &snapshot,
            &[change("owned.txt", Some(b"worker"))],
            || Ok(()),
            |change| write_isolated_change(snapshot.source_handle(), change),
            || anyhow::bail!("injected commit failure"),
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read(source.path().join("owned.txt")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn command_requirement_needs_a_native_terminal_receipt() {
        let claim = json!({"type":"item.completed","item":{"type":"agent_message", "text":"I ran all tests and edited the file."}});
        let started = json!({"type":"item.started","item":{"type":"command_execution","status":"in_progress","exit_code":null}});
        assert!(!isolated_worker_observed_command(&[claim, started]));
        let incomplete = json!({"type":"item.completed","item":{"type":"command_execution","status":"completed","exit_code":null}});
        assert!(!isolated_worker_observed_command(&[incomplete]));
        for (status, exit) in [("completed", 0), ("failed", 1)] {
            let terminal = json!({"type":"item.completed","item":{"type":"command_execution","status":status,"exit_code":exit}});
            assert!(isolated_worker_observed_command(&[terminal]));
        }
    }

    #[test]
    fn read_only_paths_override_owned_globs_and_reject_traversal() {
        let source = TempDir::new().unwrap();
        let owned = vec![DirectOwnedWriteScope {
            display_path: "poems/**".into(),
            kind: DirectOwnedWriteScopeKind::RecursiveGlob {
                prefix: "poems".into(),
            },
        }];
        let read_only = vec!["poems/private/**".into(), "poems/reference.txt".into()];
        let owns = |path: &str| isolated_worker_owns_path(&owned, &read_only, source.path(), path);
        assert!(owns("poems/new.txt"));
        assert!(!owns("poems/private/reference.txt"));
        assert!(!owns("poems/reference.txt"));
        assert!(!owns("poems/../escape.txt"));
        let snapshot =
            IsolatedWorkspace::snapshot(source.path(), SnapshotLimits::default()).unwrap();
        fs::create_dir_all(snapshot.workspace_dir().join("poems")).unwrap();
        fs::write(snapshot.workspace_dir().join("poems/new.txt"), b"owned").unwrap();
        fs::write(
            snapshot.workspace_dir().join("poems/reference.txt"),
            b"forbidden",
        )
        .unwrap();
        assert!(snapshot.collect_changes(owns).is_err());
    }

    #[test]
    fn failed_later_write_restores_edits_deletions_and_new_files() {
        let source = TempDir::new().unwrap();
        fs::write(source.path().join("edit.txt"), b"original edit").unwrap();
        fs::write(source.path().join("delete.txt"), b"original delete").unwrap();
        let snapshot =
            IsolatedWorkspace::snapshot(source.path(), SnapshotLimits::default()).unwrap();
        let changes = vec![
            change("edit.txt", Some(b"new")),
            change("delete.txt", None),
            change("created.txt", Some(b"created")),
            change("failed.txt", Some(b"renamed before failure")),
        ];
        let result = apply_isolated_changes_with(
            &snapshot,
            &changes,
            || Ok(()),
            |change| {
                write_isolated_change(snapshot.source_handle(), change)?;
                anyhow::ensure!(
                    change.path != "failed.txt",
                    "injected durability failure after rename"
                );
                Ok(())
            },
            || Ok(()),
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("original file contents restored")
        );
        assert_eq!(
            fs::read(source.path().join("edit.txt")).unwrap(),
            b"original edit"
        );
        assert_eq!(
            fs::read(source.path().join("delete.txt")).unwrap(),
            b"original delete"
        );
        assert!(!source.path().join("created.txt").exists());
        assert!(!source.path().join("failed.txt").exists());
    }

    #[test]
    fn cancellation_after_local_write_restores_source_before_checkpoint() {
        let source = TempDir::new().unwrap();
        fs::write(source.path().join("owned.txt"), b"original").unwrap();
        let snapshot =
            IsolatedWorkspace::snapshot(source.path(), SnapshotLimits::default()).unwrap();
        let changes = vec![change("owned.txt", Some(b"worker"))];
        let checks = Cell::new(0);
        let result = apply_isolated_changes_with(
            &snapshot,
            &changes,
            || {
                let count = checks.get();
                checks.set(count + 1);
                anyhow::ensure!(count == 0, "canceled");
                Ok(())
            },
            |change| write_isolated_change(snapshot.source_handle(), change),
            || Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read(source.path().join("owned.txt")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn rollback_snapshot_failure_precedes_every_write() {
        let source = TempDir::new().unwrap();
        fs::write(source.path().join("first.txt"), b"original").unwrap();
        fs::write(source.path().join("second.txt"), b"original").unwrap();
        let snapshot =
            IsolatedWorkspace::snapshot(source.path(), SnapshotLimits::default()).unwrap();
        fs::write(source.path().join("second.txt"), b"concurrent parent edit").unwrap();
        let changes = vec![
            change("first.txt", Some(b"worker")),
            change("second.txt", Some(b"worker")),
        ];
        let writes = Cell::new(0);
        let result = apply_isolated_changes_with(
            &snapshot,
            &changes,
            || Ok(()),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
            || Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
        assert_eq!(
            fs::read(source.path().join("first.txt")).unwrap(),
            b"original"
        );
    }
}
