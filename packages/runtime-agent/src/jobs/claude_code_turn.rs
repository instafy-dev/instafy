//! A local-engine turn (docs/Local-Engine-Turns.md 3.1, 11.12, 11.19, 11.23): the person's own
//! Claude Code, signed in on this computer in the folder of the login the turn's lease took,
//! carries out one turn of their agent, in the space's folder or, on a computer that runs turns at
//! once, in a folder of its own cloned from it (`turn_folder`), and the turn saves what it
//! changed, unless it only plans (`plan_only`). In order:
//!
//! 1. Without a folder of its own, the job's process-environment lock, as for every turn; then
//!    whether its lease still holds.
//! 2. The workspace token, verified: the end-of-turn save needs it, and a lane job has no
//!    controller token to fall back on.
//! 3. The folder: made if missing, brought up to date, its scaffold, the controller's pages. A
//!    pre-turn refresh that refuses saves ends the turn before anything starts. A turn of its own
//!    folder is cloned from the space's folder then, and runs there from here on.
//! 4. The pre-flight of 3.9 (`claude_code::preflight`), which a Stop ends.
//! 5. The starting point: the folder's `git status` (without one the turn ends here), the record a
//!    Stop reports from, and the pages of other chats the turn holds.
//! 6. The per-turn probe of the program and the turn's login, which decides, and which a plan
//!    limit's hold of that login fails (11.11); then whether the lease still holds, as the last
//!    step before the spawn.
//! 7. `claude`, with the login's `CLAUDE_CONFIG_DIR` (none for Claude Code's usual folder), run and
//!    stopped by `claude_code::supervise`, its steps and reply draft streamed through the handler
//!    every turn shares. It resumes the lane's session whichever computer saved it; when this one
//!    does not have it, `claude` starts once more in a new session (11.9).
//! 8. The save of a successful run that applies its changes, through the lane filter
//!    (`claude_code::saves`), and the turn's [`JobExecution`]: provider `claude-code`, the lane's
//!    conversation state, `apply/files`, `origin/apply`, `claude-code/usage` and
//!    `claude-code/run-log`, never a `codex/run-log`. A `plan_only` turn saves nothing.
//!
//! A turn of its own folder saves by merging into the space's folder
//! (`workspace_commit::save_turn_folder`), and what the space changed meanwhile is kept aside, on
//! a recovery ref. When it saves nothing (it failed, was stopped, or its save failed), its changes
//! are put into the space's folder unsaved, so they stay there as after a turn that ran there.
//!
//! However `claude` ended, what it changed under another chat's page is put back first. A failure
//! saves nothing and fails the job with its `claude-code/failure` code; one at the Claude plan's
//! limit also holds the turn's login until the limit resets, while the person's other logins keep
//! taking turns (11.11, 11.19). A save that fails after a run that went well fails nothing: the
//! reply is delivered, with a note that the changes stayed on this computer (D-C/D-V). A Stop ends
//! as a lost lease, and the executor reports what the turn changed. While the runtime shuts down,
//! the turn reports nothing.
//!
//! Every status step the turn sends as a note (what stayed on this computer, what was not saved,
//! permission denials, programs stopped) carries `presentation.placement: "reply_note"`: Studio
//! shows it under the reply once the turn is done, whether Details is open or not.

use super::*;
use crate::claude_code::command::{McpConfigFile, StartAgain, turn_command};
use crate::claude_code::events::{EventAdapter, LaneFailure, PROVIDER, Redactor};
use crate::claude_code::events::{redact_tokens, reply_note};
use crate::claude_code::job::{
    LaneJob, failure_artifacts, not_ready_failure, plan_limit_hold_failure, resume_session,
};
use crate::claude_code::saves::{KeptOff, kept_off_all, kept_off_sentence};
use crate::claude_code::supervise::{TurnEnd, TurnSpec, supervise};
use crate::claude_code::{FailureCode, Readiness};

/// A lane failure as the job's error: its `claude-code/failure` artifact, when it has a code, and
/// `extra` artifacts. Its text has any `sk-ant-` token replaced, as every string the lane sends
/// (3.6).
fn lane_error(failure: LaneFailure, extra: Vec<JsonValue>) -> anyhow::Error {
    let mut artifacts = failure_artifacts(&failure);
    artifacts.extend(extra);
    anyhow::Error::new(JobFailureWithArtifacts {
        message: redact_tokens(&failure.message),
        artifacts,
    })
}

/// The note of a turn that went well whose save failed: its changes are in the folder on this
/// computer only (D-C/D-V). Details holds the error (`origin/apply-error`).
const CHANGES_NOT_SAVED: &str =
    "Claude Code's changes stayed on this computer and weren't saved to the space.";

/// A failure with no code of 5.5's table: its own words, in Details.
fn uncoded(message: impl Into<String>) -> LaneFailure {
    LaneFailure {
        code: None,
        message: message.into(),
        resets_at: None,
    }
}

/// A status step of the turn: a note under its reply, never part of it (3.7), which Studio shows
/// there once the turn is done ([`reply_note`]).
pub(super) fn status_step(content: String, kind: &str, details: JsonValue) -> JobMessage {
    let mut metadata = json!({ "kind": kind, "presentation": reply_note() });
    if let (Some(map), JsonValue::Object(details)) = (metadata.as_object_mut(), details) {
        map.extend(details);
    }
    JobMessage {
        content,
        message_type: Some("status".to_string()),
        metadata: Some(metadata),
    }
}

/// The status step of a turn that left programs running, which the runtime stopped as the turn
/// ended (3.6). Background commands and helpers a turn starts do not outlive it.
pub(super) fn programs_stopped_step(count: usize) -> Option<JobMessage> {
    let sentence = match count {
        0 => return None,
        1 => "Claude Code left 1 program running when it finished; Instafy stopped it.".to_string(),
        count => format!(
            "Claude Code left {count} programs running when it finished; Instafy stopped them."
        ),
    };
    Some(status_step(
        sentence,
        "claude_code_programs_stopped",
        json!({ "count": count }),
    ))
}

/// The `apply/files` artifact of a lane save: the files it saved, by their folder-relative paths,
/// as Studio's file list and Undo read them (3.8).
fn apply_files_artifact(files: &[CodexFileDescriptor]) -> JsonValue {
    json!({
        "kind": "apply/files",
        "files": files.iter().map(apply_files_entry).collect::<Vec<_>>(),
        "metadata": { "provider": PROVIDER },
    })
}

impl JobProcessor {
    /// Runs a local-engine turn: see the module's description for its steps.
    pub(super) async fn run_claude_code_turn(
        &self,
        registration: &Registration,
        job: &LeaseJob,
        commit_to_workspace: bool,
        progress: Option<JobProgress>,
        cancel_signal: Option<JobCancelSignal>,
        turn_start: &stopped_turn::TurnStart,
    ) -> Result<JobExecution> {
        // The checks of 3.9 that need only the job and the grant, again as the turn starts.
        let lane = self
            .claude_code_lane()
            .map_err(|reason| lane_error(not_ready_failure(reason), Vec::new()))?;
        let lane_job =
            LaneJob::of(job, lane.grant()).map_err(|failure| lane_error(failure, Vec::new()))?;
        let mode = lane_job.mode();
        let login = lane_job.login();

        // 1. A turn that works in a folder of its own (11.23) runs beside this runtime's other
        // Claude Code turns: its `claude` gets an environment of its own (3.4). Without one, one
        // turn's process environment at a time, as for every turn.
        let project_id = self.project_id_for_job(job)?;
        let turn_folders = (project_id == self.config.project_id)
            .then(|| self.turn_folder_place().cloned().zip(self.turn_folders()))
            .flatten();
        let _job_process_env_guard = if turn_folders.is_some() {
            None
        } else {
            Some(JOB_PROCESS_ENV_LOCK.lock().await)
        };
        ensure_lease_held(
            cancel_signal.as_ref(),
            "before the folder was brought up to date",
        )?;

        // 2. The workspace token: required, since nothing else can save the turn.
        let workspace_token = match self.verified_workspace_token(registration, job).await {
            Ok(Some(token)) => token,
            Ok(None) => {
                return Err(lane_error(
                    uncoded(
                        "Instafy couldn't confirm this turn may save to the space, so Claude Code didn't start.",
                    ),
                    Vec::new(),
                ));
            }
            Err(error) => {
                return Err(lane_error(
                    uncoded(format!(
                        "Instafy couldn't confirm this turn may save to the space, so Claude Code didn't start.\n{error:#}"
                    )),
                    Vec::new(),
                ));
            }
        };

        // 3. The folder, up to date, with its scaffold and the controller's pages.
        let space_folder = self.prepare_workspace_dir(&project_id)?;
        let pre_turn_refresh = if commit_to_workspace {
            Some(
                Box::pin(self.refresh_workspace_before_turn(
                    registration,
                    job,
                    project_id,
                    Some(workspace_token.as_str()),
                ))
                .await,
            )
        } else {
            None
        };
        // A turn whose save would be refused ends before anything starts. Every lane turn that
        // applies its changes may write files, so the lane asks as a turn that must write them
        // does; a `plan_only` turn saves nothing, so a refused save does not end it.
        let writes_files = RuntimeJobExpectations {
            workspace_file_changes: mode.saves(),
            ..RuntimeJobExpectations::default()
        };
        if let Some(failure) = turn_that_cannot_save(
            job,
            commit_to_workspace,
            false,
            writes_files,
            pre_turn_refresh.as_ref(),
        ) {
            warn!(
                job_id = %job.id,
                "this space refuses this Claude Code turn's saves; it ends before Claude Code starts"
            );
            return Err(failure.into());
        }
        learn::ensure_project_memory_scaffold_in(&space_folder, self.scaffold_scope());
        space_pages::take_the_controllers_pages(&space_folder, &job.payload);
        // A turn of its own folder runs in a clone of the space's folder as it is now (11.23).
        let turn_folder = match turn_folders.as_ref() {
            Some((place, _)) => Some(
                turn_folder::TurnFolder::clone_of(place, &turn_folder_name(job))
                    .await
                    .map_err(|error| {
                        lane_error(
                            uncoded(
                                Redactor::new(&space_folder, lane.grant().snapshot().home()).text(
                                    &format!(
                                        "Instafy couldn't make a folder of its own for this turn, so Claude Code didn't start: {error:#}"
                                    ),
                                ),
                            ),
                            Vec::new(),
                        )
                    })?,
            ),
            None => None,
        };
        let folder: PathBuf = turn_folder
            .as_ref()
            .map(|turn_folder| turn_folder.path().to_path_buf())
            .unwrap_or_else(|| space_folder.clone());

        // 4. The pre-flight: no project configuration, unsafe import or link (3.9). It refuses a
        // folder it cannot check within its own deadline, and a Stop ends it as a Stop ends the
        // rest of the turn: no completion, and the job's locks are released. What it says goes
        // through the turn's redactor, as every string the lane sends does (3.6): git's own words
        // can name the folder or the home folder.
        let stop = cancel_signal.clone().unwrap_or_default();
        tokio::select! {
            biased;
            () = stop.cancelled() => bail!("job lease lost while the folder was checked"),
            checked = crate::claude_code::preflight::check(&folder) => {
                checked.map_err(|mut failure| {
                    failure.message = Redactor::new(&folder, lane.grant().snapshot().home())
                        .text(&failure.message);
                    lane_error(failure, Vec::new())
                })?;
            }
        }

        // 5. Where the turn starts from. Without the folder's status nothing could say what the
        // turn changed, so it never starts.
        let Some(git_status_before) = collect_git_status_porcelain(&folder).await else {
            return Err(lane_error(
                LaneFailure::new(
                    FailureCode::PreflightFailed,
                    "Instafy couldn't read the state of this space's folder, so Claude Code didn't start.",
                ),
                Vec::new(),
            ));
        };
        // A turn of its own folder reads what it changed as trees (`turn_folder::snapshot`).
        let first_tree = match turn_folder.as_ref() {
            Some(_) => match turn_folder::snapshot(&folder).await {
                Some(tree) => Some(tree),
                None => {
                    return Err(lane_error(
                        LaneFailure::new(
                            FailureCode::PreflightFailed,
                            "Instafy couldn't read the state of this space's folder, so Claude Code didn't start.",
                        ),
                        Vec::new(),
                    ));
                }
            },
            None => None,
        };
        match turn_folder {
            Some(turn_folder) => turn_start.record_local_engine_turn_in(
                turn_folder,
                &git_status_before,
                &space_folder,
            ),
            None => turn_start.record_local_engine_turn(&folder, &git_status_before),
        }
        let mut held_pages = space_pages::HeldPages::of_turn(
            &folder,
            job.conversation_id.as_ref(),
            &space_pages::installed_page_commands(),
            Some(&git_status_before),
        );

        // 6. The per-turn probe of the program and the turn's login decides. One that disagrees
        // with the registered capability publishes the new value, and the registration loop
        // registers again (3.2). While a plan limit holds the login, a turn that was leased on it
        // all the same fails as `plan_limit` (11.11, 11.19).
        let probe = lane.probe_and_publish(login).await;
        if probe.capability_changed {
            tracing::info!(
                job_id = %job.id,
                %login,
                ready = probe.readiness.is_ready(),
                "the Claude Code capability changed at a turn's probe; this runtime registers again"
            );
        }
        let ready = match probe.readiness {
            Readiness::Ready(ready) => ready,
            Readiness::NotReady(reason) => {
                return Err(lane_error(not_ready_failure(reason), Vec::new()));
            }
            Readiness::Held(hold) => {
                return Err(lane_error(plan_limit_hold_failure(&hold), Vec::new()));
            }
        };
        confirm_lease_held(cancel_signal.as_ref(), "before Claude Code started").await?;

        // 7. `claude`, supervised, with the environment of the login the probe checked. It
        // resumes the lane's session whichever computer saved it; when this one does not have it,
        // the turn starts `claude` once more without `--resume`, in a new session (11.9).
        let resume = resume_session(job.payload.get("provider_conversation_state"));
        let mcp_config = McpConfigFile::create(lane.grant()).map_err(|error| {
            lane_error(
                uncoded(format!(
                    "Instafy couldn't write Claude Code's settings for this turn, so it didn't start: {error}"
                )),
                Vec::new(),
            )
        })?;
        let command = turn_command(lane.grant(), &ready, &mcp_config, mode, resume, &folder);
        let start_again = resume.map(|_| StartAgain {
            grant: lane.grant(),
            ready: &ready,
            mcp_config: &mcp_config,
            mode,
            folder: &folder,
        });
        let mut adapter = EventAdapter::for_turn(lane.grant(), &folder, mode);
        let mut reply_draft = progress
            .as_ref()
            .and_then(|progress| progress.reply_draft.clone())
            .map(|sender| reply_draft::ReplyDraftStream::start(sender, true, false));
        let mut steps = progress.as_ref().map(StepStream::of);
        let mut events: Vec<JsonValue> = Vec::new();
        let runtime_id = registration.runtime_id;
        let job_id = job.id;
        let shutdown = self.shutdown_signal();
        let limits = self.claude_code_turn_limits();
        tracing::info!(
            job_id = %job.id,
            %login,
            cli = %ready.cli(),
            mode = mode.as_str(),
            resumed = resume.is_some(),
            "starting the person's Claude Code for a local-engine turn"
        );
        let outcome = {
            let mut on_event = |event: &JsonValue| {
                events.push(event.clone());
                stream_turn_event(
                    event,
                    reply_draft.as_mut(),
                    steps.as_mut(),
                    &extract_codex_messages,
                    &runtime_id,
                    job_id,
                );
            };
            supervise(
                command,
                TurnSpec {
                    prompt: lane_job.prompt(),
                    start_again,
                    stop: &stop,
                    shutdown: &shutdown,
                },
                &limits,
                &mut adapter,
                &mut on_event,
            )
            .await
        };
        drop(mcp_config);
        drop(reply_draft);
        tracing::info!(
            job_id = %job.id,
            end = ?outcome.end,
            exit = ?outcome.exit_status,
            cleanup_confirmed = outcome.cleanup_confirmed,
            started_again = outcome.started_again,
            "Claude Code's turn ended"
        );
        // However the run ended, the runtime's shutdown included, a page another chat made is as
        // it was before anything reads the folder (3.8, step 2). It is a change on this computer
        // only, so a turn that reports nothing still makes it.
        held_pages
            .put_back(
                &folder,
                Some(&git_status_before),
                space_pages::TurnSteps::of_events(&folder, &events),
            )
            .await;
        // A turn of its own folder that will not save puts what it changed into the space's
        // folder, unsaved, where a turn that ran there would have left it (11.23).
        let saves = commit_to_workspace && mode.saves();
        if let Some(first_tree) = first_tree.as_deref()
            && saves
            && !matches!(outcome.end, TurnEnd::Succeeded)
        {
            self.put_turn_folder_changes(&folder, first_tree, &held_pages, job)
                .await;
        }
        if matches!(outcome.end, TurnEnd::Shutdown) {
            return Err(anyhow::Error::new(stopped_turn::ShutdownReportsNothing));
        }
        let mut artifacts: Vec<JsonValue> = Vec::new();
        artifacts.extend(adapter.usage_artifact());
        artifacts.push(adapter.run_log().artifact());
        let programs_stopped = outcome.programs_stopped;
        match outcome.end {
            TurnEnd::Succeeded => {}
            TurnEnd::Shutdown | TurnEnd::Stopped => {
                // No completion: the executor reports what the turn changed (3.6, step 5).
                bail!("job lease lost while Claude Code ran");
            }
            TurnEnd::Failed(failure) => {
                warn!(
                    job_id = %job.id,
                    code = ?failure.code,
                    "Claude Code's turn failed; nothing is saved"
                );
                // The person's other waiting turns on this login wait for its plan's limit to
                // reset, instead of each starting and failing in turn; their other logins keep
                // taking turns (11.11, 11.19).
                if failure.code == Some(FailureCode::PlanLimit) {
                    lane.hold_for_plan_limit(login, failure.resets_at);
                }
                return Err(lane_error(failure, artifacts));
            }
        }

        // 8. The save, of a turn that applies its changes: a `plan_only` turn saves nothing, and
        // its reply is delivered all the same (11.12).
        let progress_sender = progress.as_ref().map(|progress| progress.sender.clone());
        let mut status_steps: Vec<JobMessage> = Vec::new();
        let mut not_saved = pre_turn_refresh
            .as_ref()
            .map(workspace_commit::PreTurnRefreshOutcome::not_saved_sentences)
            .unwrap_or_default();
        let mut files: Vec<CodexFileDescriptor> = Vec::new();
        let mut saved = false;
        if let Some(first_tree) = first_tree.as_deref()
            && saves
        {
            let saving = self
                .save_turn_folder(TurnFolderTurn {
                    registration,
                    job,
                    project_id,
                    folder: &folder,
                    space_folder: &space_folder,
                    first_tree,
                    workspace_token: &workspace_token,
                    progress_sender: progress_sender.clone(),
                    cancel_signal: cancel_signal.as_ref(),
                    held_pages: &held_pages,
                    redactor: adapter.redactor(),
                })
                .await?;
            files = saving.files;
            saved = saving.saved;
            artifacts.extend(saving.artifacts);
            not_saved.extend(saving.not_saved);
            status_steps.extend(saving.status_steps);
        } else if saves {
            match collect_git_status_porcelain(&folder).await {
                Some(after) => {
                    files = status_delta_files_for_checkpoint(&git_status_before, &after, &[]);
                }
                None => status_steps.push(status_step(
                    "Claude Code's changes stayed on this computer and weren't saved to the space: Instafy couldn't read what changed in this space's folder.".to_string(),
                    "claude_code_changes_not_saved",
                    json!({ "reason": "status_unreadable" }),
                )),
            }
            held_pages.leave_out_held(&mut files);
            let reasons = kept_off_all(
                &folder,
                files
                    .iter()
                    .map(|file| file.workspace_path.clone())
                    .collect(),
            )
            .await;
            let mut kept: Vec<(String, KeptOff)> = Vec::new();
            let mut reasons = reasons.into_iter();
            files.retain(|file| match reasons.next().flatten() {
                Some(reason) => {
                    kept.push((file.workspace_path.clone(), reason));
                    false
                }
                None => true,
            });
            if let Some(sentence) = kept_off_sentence(&kept) {
                status_steps.push(status_step(
                    adapter.redactor().text(&sentence),
                    "claude_code_not_saved",
                    json!({
                        "paths": kept
                            .iter()
                            .map(|(path, _)| redact_tokens(path))
                            .collect::<Vec<_>>(),
                    }),
                ));
            }
            if !files.is_empty() {
                if let Some(sender) = progress_sender.as_ref() {
                    let _ = sender.send(JobMessage {
                        content: "Syncing workspace changes…".to_string(),
                        message_type: Some("status".to_string()),
                        metadata: Some(json!({
                            "kind": "workspace_commit",
                            "status": "started",
                            "activity": activity_labels::runtime_status_activity("workspace_commit"),
                        })),
                    });
                }
                match workspace_commit::commit_to_hosted_origin(
                    &self.config.controller_base_url,
                    &workspace_token,
                    project_id,
                    registration.runtime_id,
                    job.id,
                    job.run_id,
                    &folder,
                    &files,
                    None,
                    progress_sender.clone(),
                    self.local_origin_sync(),
                    &workspace_commit::version_title(job),
                )
                .await
                {
                    Ok(Some(result)) => {
                        artifacts.push(origin_apply_artifact(&result, None));
                        saved = true;
                        not_saved.extend(result.not_saved_sentences());
                        if let Some(sender) = progress_sender.as_ref() {
                            let _ = sender.send(workspace_commit_progress_message(&result));
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        // A Stop that came before the save was let in: the turn ends as a
                        // stopped one, with its change kept.
                        if stopped_turn::a_stop_refused_the_save(cancel_signal.as_ref()).await {
                            return Err(
                                error.context("job lease lost before its changes were saved")
                            );
                        }
                        // The run went well, so its reply is delivered: the turn is not failed.
                        // Its changes stay on this computer, a note says so, and Details has the
                        // error. Nothing was saved, so `apply/files` lists nothing (D-C/D-V).
                        let error = adapter.redactor().text(&format!("{error:#}"));
                        warn!(
                            job_id = %job.id,
                            %error,
                            "Claude Code's changes couldn't be saved to the space; they stay on this computer"
                        );
                        artifacts.push(json!({
                            "kind": "origin/apply-error",
                            "metadata": { "error": error },
                        }));
                        status_steps.push(status_step(
                            CHANGES_NOT_SAVED.to_string(),
                            "claude_code_changes_not_saved",
                            json!({
                                "reason": "save_failed",
                                "paths": files
                                    .iter()
                                    .map(|file| redact_tokens(&file.workspace_path))
                                    .collect::<Vec<_>>(),
                            }),
                        ));
                        files.clear();
                    }
                }
            }
        }
        // The open views of the sites the save changed reload, and their previews are pictured
        // again; the reply waits for neither. There are no page cards in v1 (3.8, step 5).
        preview_pictures::reload_and_picture_turn_sites(
            &space_folder,
            project_id,
            false,
            &files,
            saved,
            cancel_signal.clone(),
            self.picture_sender(),
        );
        artifacts.insert(0, apply_files_artifact(&files));
        artifacts.extend(held_pages.artifact());

        // What stayed on this computer, and what was not saved: notes of their own, never lines
        // appended to the reply (3.7).
        let mut held_lines = String::new();
        held_pages.reply(&mut held_lines, &files);
        if !held_lines.trim().is_empty() {
            status_steps.push(status_step(
                adapter.redactor().text(held_lines.trim()),
                "claude_code_held_pages",
                json!({}),
            ));
        }
        let mut not_saved_text = String::new();
        save_report::append_not_saved(&mut not_saved_text, &not_saved);
        if !not_saved_text.trim().is_empty() {
            status_steps.push(status_step(
                adapter.redactor().text(not_saved_text.trim()),
                "claude_code_save_not_saved",
                json!({}),
            ));
        }
        status_steps.extend(adapter.permission_denials_step());
        status_steps.extend(programs_stopped_step(programs_stopped));
        status_steps.extend(super::put_back_edit_messages(
            &held_pages,
            &folder,
            &[&events],
        ));

        let messages = with_runtime_metadata_vec(extract_codex_messages(&events), &runtime_id);
        let messages_streamed = steps.as_ref().is_some_and(StepStream::all_streamed);
        Ok(JobExecution {
            summary: adapter.reply().unwrap_or_default().to_string(),
            suggested_replies: Vec::new(),
            provider: PROVIDER.to_string(),
            artifacts,
            provider_conversation_state: adapter.conversation_state(registration.runtime_id),
            messages,
            messages_streamed,
            final_messages: with_runtime_metadata_vec(status_steps, &runtime_id),
        })
    }
}

/// What a turn that works in a folder of its own needs for its save (docs/Local-Engine-Turns.md
/// 11.23).
struct TurnFolderTurn<'a> {
    registration: &'a Registration,
    job: &'a LeaseJob,
    project_id: Uuid,
    /// The turn's own folder.
    folder: &'a Path,
    /// The space's folder, which the save merges into.
    space_folder: &'a Path,
    /// The turn folder's files as the turn began (`turn_folder::snapshot`).
    first_tree: &'a str,
    workspace_token: &'a str,
    progress_sender: Option<JobMessageSender>,
    cancel_signal: Option<&'a JobCancelSignal>,
    held_pages: &'a space_pages::HeldPages,
    redactor: &'a Redactor,
}

/// What the save of a turn of its own folder gives its reply.
#[derive(Default)]
struct TurnFolderSaving {
    /// The files it saved, as `apply/files` lists them.
    files: Vec<CodexFileDescriptor>,
    saved: bool,
    artifacts: Vec<JsonValue>,
    /// "Not saved: …" sentences.
    not_saved: Vec<String>,
    status_steps: Vec<JobMessage>,
}

/// The name of a turn's folder: its agent's id, so the agent's Claude Code sessions stay in one
/// place, else its handle, else the job's id (11.23).
fn turn_folder_name(job: &LeaseJob) -> String {
    let agent = job.payload.pointer("/metadata/agent");
    agent
        .and_then(|agent| agent.get("id"))
        .and_then(JsonValue::as_str)
        .or_else(|| {
            agent
                .and_then(|agent| agent.get("handle"))
                .and_then(JsonValue::as_str)
        })
        .map(str::to_string)
        .unwrap_or_else(|| job.id.to_string())
}

/// The turn's agent's handle, which a merged file's conflict labels would name.
fn turn_agent_handle(job: &LeaseJob) -> String {
    job.payload
        .pointer("/metadata/agent/handle")
        .and_then(JsonValue::as_str)
        .unwrap_or("agent")
        .to_string()
}

/// The note of a save that merged the turn's changes with the space's (11.23).
fn merged_sentence(paths: &[String]) -> String {
    let named = paths.join(", ");
    if paths.len() == 1 {
        format!(
            "Claude Code's changes to {named} were merged with changes made in the space while it worked."
        )
    } else {
        format!(
            "Claude Code's changes to {named} were merged with changes made in the space while it worked, file by file."
        )
    }
}

impl JobProcessor {
    /// What a turn of its own folder changed (11.23): the files that differ between its first
    /// tree and its folder now, without those under another chat's page or kept off a lane save
    /// (3.8), with what the turn found at each, and the kept-off paths with their reasons.
    /// `None` when the folder cannot be read.
    #[allow(clippy::type_complexity)]
    async fn turn_folder_changes(
        &self,
        folder: &Path,
        first_tree: &str,
        held_pages: &space_pages::HeldPages,
    ) -> Option<(
        Vec<CodexFileDescriptor>,
        std::collections::BTreeMap<String, turn_folder::BaseEntry>,
        Vec<(String, KeptOff)>,
    )> {
        let last_tree = turn_folder::snapshot(folder).await?;
        let mut files = turn_folder::changed_files(folder, first_tree, &last_tree).await?;
        held_pages.leave_out_held(&mut files);
        let reasons = kept_off_all(
            folder,
            files
                .iter()
                .map(|file| file.workspace_path.clone())
                .collect(),
        )
        .await;
        let mut kept: Vec<(String, KeptOff)> = Vec::new();
        let mut reasons = reasons.into_iter();
        files.retain(|file| match reasons.next().flatten() {
            Some(reason) => {
                kept.push((file.workspace_path.clone(), reason));
                false
            }
            None => true,
        });
        let paths: Vec<String> = files
            .iter()
            .map(|file| file.workspace_path.clone())
            .collect();
        let found = turn_folder::entries_in(folder, first_tree, &paths).await?;
        Some((files, found, kept))
    }

    /// The turn's versions of `paths`, which the space's folder changed too, kept from `folder`
    /// on a recovery ref of the space's repository (11.23): its name, when one was made.
    async fn keep_turn_folder_versions(&self, folder: &Path, paths: &[String]) -> Option<String> {
        let hold = self.turn_folders()?;
        match hold.keep(folder.to_path_buf(), paths.to_vec()).await {
            Ok(Some(kept)) => Some(kept.reference),
            Ok(None) => None,
            Err(error) => {
                warn!(
                    %error,
                    "a turn folder's versions of files the space changed too could not be kept"
                );
                None
            }
        }
    }

    /// Puts what a turn of its own folder changed into the space's folder, unsaved, where a
    /// turn that ran there would have left it (11.23): when it failed, was stopped, or its save
    /// failed. Each file goes only while the space's folder still holds what the turn found
    /// there; the turn's version of a file the space changed too is kept on a recovery ref.
    /// Returns the paths put in.
    async fn put_turn_folder_changes(
        &self,
        folder: &Path,
        first_tree: &str,
        held_pages: &space_pages::HeldPages,
        job: &LeaseJob,
    ) -> Vec<String> {
        let Some(hold) = self.turn_folders() else {
            warn!(job_id = %job.id, "a turn folder's changes have no origin to go to");
            return Vec::new();
        };
        let Some((files, found, _kept_off)) = self
            .turn_folder_changes(folder, first_tree, held_pages)
            .await
        else {
            warn!(job_id = %job.id, "a turn folder's changes could not be read");
            return Vec::new();
        };
        let mut changes: Vec<(String, Option<Vec<u8>>)> = Vec::new();
        let mut expected = std::collections::BTreeMap::new();
        for file in &files {
            let path = file.workspace_path.clone();
            if found.get(&path).is_some_and(|entry| entry.link) {
                continue;
            }
            let bytes = match std::fs::symlink_metadata(folder.join(&path)) {
                Ok(metadata) if metadata.is_file() => match std::fs::read(folder.join(&path)) {
                    Ok(bytes) => Some(bytes),
                    Err(_) => continue,
                },
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => continue,
            };
            expected.insert(
                path.clone(),
                found.get(&path).map(|entry| entry.oid.clone()),
            );
            changes.push((path, bytes));
        }
        if changes.is_empty() {
            return Vec::new();
        }
        let put = match hold.put_unsaved(changes, expected).await {
            Ok(put) => put,
            Err(error) => {
                warn!(job_id = %job.id, %error, "a turn folder's changes could not be put into the space's folder");
                return Vec::new();
            }
        };
        if !put.changed.is_empty() {
            self.keep_turn_folder_versions(folder, &put.changed).await;
        }
        put.put
    }

    /// The save of a turn of its own folder (11.23): what it changed merges into the space's
    /// folder (`workspace_commit::save_turn_folder`), the turn's versions of files the space
    /// changed too are kept on a recovery ref, and a save that fails puts the changes into the
    /// space's folder unsaved, with a note, as a failed save of a turn there leaves them (3.8).
    async fn save_turn_folder(&self, turn: TurnFolderTurn<'_>) -> Result<TurnFolderSaving> {
        let mut saving = TurnFolderSaving::default();
        let Some((mut files, found, kept_off)) = self
            .turn_folder_changes(turn.folder, turn.first_tree, turn.held_pages)
            .await
        else {
            saving.status_steps.push(status_step(
                "Claude Code's changes weren't saved to the space: Instafy couldn't read what changed in this turn's folder.".to_string(),
                "claude_code_changes_not_saved",
                json!({ "reason": "status_unreadable" }),
            ));
            return Ok(saving);
        };
        if let Some(sentence) = kept_off_sentence(&kept_off) {
            saving.status_steps.push(status_step(
                turn.redactor.text(&sentence),
                "claude_code_not_saved",
                json!({
                    "paths": kept_off
                        .iter()
                        .map(|(path, _)| redact_tokens(path))
                        .collect::<Vec<_>>(),
                }),
            ));
        }
        if files.is_empty() {
            return Ok(saving);
        }
        if let Some(sender) = turn.progress_sender.as_ref() {
            let _ = sender.send(JobMessage {
                content: "Syncing workspace changes…".to_string(),
                message_type: Some("status".to_string()),
                metadata: Some(json!({
                    "kind": "workspace_commit",
                    "status": "started",
                    "activity": activity_labels::runtime_status_activity("workspace_commit"),
                })),
            });
        }
        let agent = turn_agent_handle(turn.job);
        let saved = workspace_commit::save_turn_folder(
            &self.config.controller_base_url,
            turn.workspace_token,
            turn.project_id,
            turn.registration.runtime_id,
            turn.job.id,
            turn.job.run_id,
            workspace_commit::TurnFolderSave {
                turn_folder: turn.folder,
                space_folder: turn.space_folder,
                found: &found,
                agent: &agent,
            },
            &files,
            turn.progress_sender.clone(),
            self.local_origin_sync(),
            &workspace_commit::version_title(turn.job),
        )
        .await;
        match saved {
            Ok(outcome) => {
                if let Some(result) = outcome.result.as_ref() {
                    saving.artifacts.push(origin_apply_artifact(result, None));
                    saving.saved = true;
                    saving.not_saved.extend(result.not_saved_sentences());
                    if let Some(sender) = turn.progress_sender.as_ref() {
                        let _ = sender.send(workspace_commit_progress_message(result));
                    }
                }
                if !outcome.kept.is_empty() {
                    let recovery_ref = self
                        .keep_turn_folder_versions(turn.folder, &outcome.kept)
                        .await;
                    let report = save_report::SaveReport {
                        recovery_ref,
                        conflicted_paths: outcome
                            .kept
                            .iter()
                            .map(|path| redact_tokens(path))
                            .collect(),
                        ..save_report::SaveReport::default()
                    };
                    saving
                        .not_saved
                        .extend(report.not_saved_sentences(&[], None));
                }
                if !outcome.merged.is_empty() {
                    saving.status_steps.push(status_step(
                        turn.redactor.text(&merged_sentence(&outcome.merged)),
                        "claude_code_merged",
                        json!({
                            "paths": outcome
                                .merged
                                .iter()
                                .map(|path| redact_tokens(path))
                                .collect::<Vec<_>>(),
                        }),
                    ));
                }
                files.retain(|file| outcome.saved.contains(&file.workspace_path));
                saving.files = files;
            }
            Err(error) => {
                // A Stop that came before the save was let in: the turn ends as a stopped one,
                // with its change kept in the space's folder.
                if stopped_turn::a_stop_refused_the_save(turn.cancel_signal).await {
                    self.put_turn_folder_changes(
                        turn.folder,
                        turn.first_tree,
                        turn.held_pages,
                        turn.job,
                    )
                    .await;
                    return Err(error.context("job lease lost before its changes were saved"));
                }
                // The run went well, so its reply is delivered: the turn is not failed. Its
                // changes go into the space's folder unsaved, a note says so, and Details has
                // the error (D-C/D-V).
                let error = turn.redactor.text(&format!("{error:#}"));
                warn!(
                    job_id = %turn.job.id,
                    %error,
                    "a turn folder's changes couldn't be saved to the space; they go into its folder unsaved"
                );
                self.put_turn_folder_changes(
                    turn.folder,
                    turn.first_tree,
                    turn.held_pages,
                    turn.job,
                )
                .await;
                saving.artifacts.push(json!({
                    "kind": "origin/apply-error",
                    "metadata": { "error": error },
                }));
                saving.status_steps.push(status_step(
                    CHANGES_NOT_SAVED.to_string(),
                    "claude_code_changes_not_saved",
                    json!({
                        "reason": "save_failed",
                        "paths": files
                            .iter()
                            .map(|file| redact_tokens(&file.workspace_path))
                            .collect::<Vec<_>>(),
                    }),
                ));
            }
        }
        Ok(saving)
    }
}
