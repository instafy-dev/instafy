//! A stopped turn's unsaved change, when the chat's next turn begins.
//!
//! A turn the person stops keeps what it changed in its folder, never saved
//! (`stopped_turn`): its row reads "Not saved", with Undo. A save takes whole
//! files, so the chat's next turn, changing one of those files, saved the
//! stopped change with its own, and nothing said so.
//!
//! So a turn that may save first puts that change back, as the change's own
//! Undo does ([`JobProcessor::put_back_stopped_changes`]). It reads the chat's
//! history for the reports of turns the person stopped and has not asked for
//! again, whose files this machine's folder holds and that no Undo took back
//! ([`unsaved_changes`]). The origin in this process puts each one's files
//! back as the saved version has them, with what they held kept under Unsaved
//! work: only while each still holds what the turn left, and only for a
//! change whose files the turn found as saved, as that Undo requires. The
//! controller then records the line an Undo leaves, in its words for this
//! (`/agent/stopped/put-back`), so the stopped row reads "Undone" in every
//! Studio, and this turn and later ones read that the files no longer hold
//! the change.
//!
//! A change that can't be put back stays: the person changed a file since,
//! the turn found one already changed, or no origin in this process serves
//! the folder. So does one the person asked to go on with (Continue under the
//! Stop), which is theirs to keep. When this turn's save then takes a file
//! that still held such a change ([`StandingChanges::saved_with`]), the
//! reply's `stopped-turn/saved-later` artifact names the stopped row's message
//! and those files, so that row says a later change saved them, and, unless
//! the person asked to go on with it, the reply says so in one sentence.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::Duration;

use serde_json::{Value as JsonValue, json};
use tracing::{info, warn};
use uuid::Uuid;

use super::conversation_context::{is_stopped_turns_report, is_undo_line, stopped_request_of};
use super::workspace_commit::CommitToOriginResult;
use super::{GitStatusEntry, JobProcessor};
use crate::controller::{ControllerClient, LeaseJob, Registration};
use crate::job_cancel::JobCancelSignal;

/// The reply's artifact that names the stopped changes its save took.
const SAVED_LATER_ARTIFACT_KIND: &str = "stopped-turn/saved-later";

/// The longest quote of the stopped request the reply's sentence carries.
const REQUEST_QUOTE_MAX_CHARS: usize = 80;

/// How long to wait before each try again, after a try to record a change put
/// back that never reached the controller or failed there: the change is
/// already back, and its row reads as undone only once the line is recorded.
const RECORD_RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

/// What a stopped turn left unsaved in this machine's folder, from its report
/// in the chat's history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UnsavedChange {
    /// The report's message: the row that shows the change.
    message_id: String,
    /// The person stopped its request and has not asked for it again.
    stopped: bool,
    /// That request in the person's words, when the history shows them.
    request: Option<String>,
    /// What the turn left in each file no Undo took back: its blob id, or
    /// `None` for nothing there.
    left_as: BTreeMap<String, Option<String>>,
    /// The turn found one of its files already changed: putting the change
    /// back would take that back too.
    changed_before: bool,
}

fn text<'a>(value: &'a JsonValue, pointer: &str) -> Option<&'a str> {
    value
        .pointer(pointer)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// A file's path as the reports, the Undo lines and a save name it.
fn path_key(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}

/// The unsaved changes of stopped turns that the folder of runtime
/// `runtime_id` may still hold, oldest first: each report in `history` whose
/// turn never saved (`stoppedBeforeSave`) and says what it left in its files
/// on that machine (`undo`), without the files an Undo's line already names.
pub(super) fn unsaved_changes(
    history: Option<&JsonValue>,
    runtime_id: &Uuid,
) -> Vec<UnsavedChange> {
    let Some(entries) = history.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    let mut undone: HashMap<&str, HashSet<String>> = HashMap::new();
    for line in entries.iter().filter(|entry| is_undo_line(entry)) {
        let Some(message_id) = text(line, "/metadata/undoneMessageId") else {
            continue;
        };
        undone.entry(message_id).or_default().extend(
            line.pointer("/metadata/undonePaths")
                .and_then(JsonValue::as_array)
                .into_iter()
                .flatten()
                .filter_map(JsonValue::as_str)
                .map(path_key),
        );
    }
    let runtime_id = runtime_id.to_string();
    let mut changes = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| is_stopped_turns_report(entry))
    {
        let Some(message_id) = text(entry, "/id") else {
            continue;
        };
        let Some(undo) = entry
            .pointer("/metadata/artifacts")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter(|artifact| {
                text(artifact, "/kind") == Some("apply/files")
                    && artifact.pointer("/metadata/stoppedBeforeSave") == Some(&json!(true))
            })
            .find_map(|artifact| artifact.pointer("/metadata/undo"))
        else {
            continue;
        };
        if text(undo, "/runtimeId") != Some(runtime_id.as_str()) {
            continue;
        }
        let taken_back = undone.get(message_id);
        let left_as: BTreeMap<String, Option<String>> = undo
            .get("leftAs")
            .and_then(JsonValue::as_object)
            .into_iter()
            .flatten()
            .filter(|(_, blob)| blob.is_null() || blob.is_string())
            .map(|(path, blob)| (path.clone(), blob.as_str().map(str::to_string)))
            .filter(|(path, _)| {
                !path_key(path).is_empty()
                    && taken_back.is_none_or(|undone| !undone.contains(&path_key(path)))
            })
            .collect();
        if left_as.is_empty() {
            continue;
        }
        let changed_before = undo
            .get("changedBefore")
            .and_then(JsonValue::as_array)
            .is_some_and(|paths| !paths.is_empty());
        let stopped = text(entry, "/runId").and_then(|run| stopped_request_of(entries, run));
        changes.push(UnsavedChange {
            message_id: message_id.to_string(),
            stopped: stopped.is_some(),
            request: stopped.flatten().map(str::to_string),
            left_as,
            changed_before,
        });
    }
    changes
}

/// A stopped turn's unsaved change this turn left in the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Standing {
    message_id: String,
    paths: BTreeSet<String>,
    /// The reply says when its save takes the change: the person stopped it
    /// and has not asked for it again.
    say: bool,
    request: Option<String>,
}

/// The stopped turns' unsaved changes a turn left in its folder as it began.
#[derive(Debug, Default)]
pub(super) struct StandingChanges(Vec<Standing>);

impl StandingChanges {
    /// What this turn's save `result` took of them: each change with a file
    /// the folder still held changed as the turn began (`before`, its `git
    /// status` then) and that reached the saved version now. The reply's
    /// artifact names each one's row and those files, and `sentences` gains
    /// one for each change the person stopped and has not asked for again.
    pub(super) fn saved_with(
        &self,
        result: &CommitToOriginResult,
        before: Option<&HashMap<String, GitStatusEntry>>,
        artifacts: &mut Vec<JsonValue>,
        sentences: &mut Vec<String>,
    ) {
        let Some(before) = before else {
            return;
        };
        if self.0.is_empty() || !result.git_sync_attempted || result.git_sync_error.is_some() {
            return;
        }
        let left_out: HashSet<String> = result
            .save
            .conflicted_paths
            .iter()
            .map(|path| path_key(path))
            .chain(
                result
                    .save
                    .rejected_paths
                    .iter()
                    .map(|rejected| path_key(&rejected.path)),
            )
            .collect();
        let saved: HashSet<String> = result
            .paths
            .iter()
            .map(|path| path_key(path))
            .filter(|path| !left_out.contains(path))
            .collect();
        let mut taken = Vec::new();
        for change in &self.0 {
            let paths: Vec<&String> = change
                .paths
                .iter()
                .filter(|path| before.contains_key(*path) && saved.contains(&path_key(path)))
                .collect();
            if paths.is_empty() {
                continue;
            }
            taken.push(json!({ "messageId": change.message_id, "paths": paths }));
            if change.say {
                let sentence = saved_too_sentence(change.request.as_deref());
                if !sentences.contains(&sentence) {
                    sentences.push(sentence);
                }
            }
        }
        if !taken.is_empty() {
            artifacts.push(json!({
                "kind": SAVED_LATER_ARTIFACT_KIND,
                "metadata": { "changes": taken },
            }));
        }
    }
}

/// What a reply says when its save took a change the person had stopped.
fn saved_too_sentence(request: Option<&str>) -> String {
    let words = request
        .map(|request| request.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|words| !words.is_empty());
    match words {
        Some(words) => {
            let quote = if words.chars().count() > REQUEST_QUOTE_MAX_CHARS {
                let cut: String = words.chars().take(REQUEST_QUOTE_MAX_CHARS - 1).collect();
                format!("{}…", cut.trim_end())
            } else {
                words
            };
            format!("This also saved the change that was stopped earlier (“{quote}”)")
        }
        None => "This also saved the change that was stopped earlier".to_string(),
    }
}

/// `job`, with `lines` in its chat's history before the message it answers:
/// the controller recorded them after that message, and the turn reads them
/// as later turns will.
fn job_with_history_lines(job: &LeaseJob, lines: Vec<JsonValue>) -> LeaseJob {
    let mut job = job.clone();
    if let Some(history) = job
        .payload
        .get_mut("conversation_history")
        .and_then(JsonValue::as_array_mut)
    {
        let answers_last = history
            .last()
            .is_some_and(|entry| text(entry, "/role") == Some("user"));
        let at = history.len() - usize::from(answers_last);
        history.splice(at..at, lines);
    }
    job
}

impl JobProcessor {
    /// Before `job`'s turn changes anything in the folder of project
    /// `project_id`: each unsaved change of a turn the person stopped, and
    /// has not asked for again, goes back as the saved version has it, with
    /// what its files held kept under Unsaved work, and the controller
    /// records it. `job` with those lines in its history when there are any,
    /// and the changes that stay in the folder. A turn that was itself
    /// stopped by now puts nothing back: it ends as one that lost its lease.
    pub(super) async fn put_back_stopped_changes(
        &self,
        registration: &Registration,
        job: &LeaseJob,
        project_id: Uuid,
        cancel_signal: Option<&JobCancelSignal>,
    ) -> anyhow::Result<(Option<LeaseJob>, StandingChanges)> {
        let changes = unsaved_changes(
            job.payload.get("conversation_history"),
            &registration.runtime_id,
        );
        if changes.is_empty() {
            return Ok((None, StandingChanges::default()));
        }
        // The origin in this process serves this runtime's own space.
        let put_back = self
            .unsaved_put_back()
            .filter(|_| project_id == self.config.project_id);
        let goes_back = |change: &UnsavedChange| change.stopped && !change.changed_before;
        if put_back.is_some() && changes.iter().any(goes_back) {
            super::confirm_lease_held(cancel_signal, "before a stopped change was put back")
                .await?;
        }
        let mut lines = Vec::new();
        let mut standing = Vec::new();
        for change in changes {
            if goes_back(&change)
                && let Some(put_back) = put_back.as_ref()
            {
                match put_back.run(change.left_as.clone()).await {
                    // No file holds the change any more.
                    Ok(paths) if paths.is_empty() => continue,
                    Ok(paths) => {
                        info!(
                            job_id = %job.id,
                            files = paths.len(),
                            "put a stopped turn's unsaved change back before this turn"
                        );
                        lines.extend(
                            self.record_put_back(
                                registration,
                                job,
                                &change.message_id,
                                &paths,
                                &RECORD_RETRY_DELAYS,
                            )
                            .await,
                        );
                        continue;
                    }
                    Err(error) => info!(
                        job_id = %job.id,
                        %error,
                        "a stopped turn's unsaved change stays in the folder"
                    ),
                }
            }
            standing.push(Standing {
                message_id: change.message_id,
                paths: change.left_as.into_keys().collect(),
                say: change.stopped,
                request: change.request,
            });
        }
        Ok((
            (!lines.is_empty()).then(|| job_with_history_lines(job, lines)),
            StandingChanges(standing),
        ))
    }

    /// The line the controller records for a change this turn put back. A
    /// try that never reached the controller, or that failed there, is made
    /// again after each of `retry_delays`; a refusal is not.
    async fn record_put_back(
        &self,
        registration: &Registration,
        job: &LeaseJob,
        message_id: &str,
        paths: &[String],
        retry_delays: &[Duration],
    ) -> Option<JsonValue> {
        let mut delays = retry_delays.iter();
        loop {
            let recorded = match ControllerClient::new(&self.config) {
                Ok(client) => {
                    client
                        .record_stopped_change_put_back(registration, job.id, message_id, paths)
                        .await
                }
                Err(error) => Err(error),
            };
            let error = match recorded {
                Ok(Some(line)) => return Some(line),
                Ok(None) => {
                    warn!(job_id = %job.id, "the controller refused to record the change put back");
                    return None;
                }
                Err(error) => error,
            };
            let Some(delay) = delays.next() else {
                warn!(
                    job_id = %job.id,
                    %error,
                    "the controller did not record the change put back"
                );
                return None;
            };
            tokio::time::sleep(*delay).await;
        }
    }
}

#[cfg(test)]
#[path = "stopped_change_tests.rs"]
mod tests;
