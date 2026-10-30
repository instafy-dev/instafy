//! One check of a reply against what its turn read, before the reply posts.
//!
//! A turn that read pages or looked something up (the browser, `instafy web read` or
//! `instafy web search`, a skill pack's lookups such as `uw cite`) can still state a fact from
//! memory as if a page said it, say that a place or a stop does not exist, or say it is taking a
//! step ("I'm sending Instafy's browser…") that the turn never started. The rule against it is in
//! the skills and the replies guide, and a model can still miss it in a long turn; only a step
//! that reads the finished reply can catch what the reply claims.
//!
//! So such a turn gets one more model call on its own thread, right after its answer: the
//! [`REPLY_CHECK_PROMPT`]. It runs with the turn's own instructions and tools, so the provider
//! serves the whole thread from its cache and only the short prompt and the reply are new (about
//! one credit on a long browser turn at the managed rates). It answers in words only
//! ([`AnswerOnly`]): a response that calls a tool runs nothing and leaves the reply, and the check
//! is one request, never replayed. It has its own time limit and its own cancel signal, which the
//! job's Stop or lost lease cancels too, so its time limit never ends the job. Its words replace
//! the turn's words only, finished as the turn's own reply was; the turn's files, cards and
//! suggestions stay as they were. A turn that read nothing is never checked, and a check that
//! cannot resume the turn's thread, fails, runs out of time, calls a tool or answers with nothing
//! usable leaves the reply as it was.

use std::time::Duration;

use serde_json::{Value as JsonValue, json};

use super::{JobMessage, activity_labels, provider_state_bool, provider_state_string};
use crate::answer_only::AnswerOnly;
use crate::codex::CodexRunOptions;
use crate::job_cancel::JobCancelSignal;
use crate::task_usage::UsageCall;

/// The check, sent as one more message on the turn's thread.
pub(super) const REPLY_CHECK_PROMPT: &str = "Before your reply goes to the person, check it once \
against what this turn did. Use no tool for this.\n\
- Mark every fact in it that no page read for this turn states as \"not checked\", or take it out.\n\
- Never say a place, stop, route or time doesn't exist unless a page read for this turn says so.\n\
- Take out any step you say you are taking that this turn didn't start; offer it as a next step \
instead.\n\
Then give your reply again, in the same form and with the same files, suggestions and actions, \
changed only where these rules need it.";

/// The longest a reply the check is given back as an artifact, for diagnosis.
const MAX_ARTIFACT_REPLY_CHARS: usize = 4_000;

/// The longest the check may take, the turn's own limit when that is shorter: one request on a
/// cached thread answers well within it, and the person is waiting for the reply.
pub(super) const REPLY_CHECK_TIME_LIMIT: Duration = Duration::from_secs(90);

/// Whether the turn's steps read a page or looked something up
/// ([`activity_labels::step_brings_in_outside_facts`]).
pub(super) fn turn_read_outside_facts<'a>(
    messages: impl IntoIterator<Item = &'a JobMessage>,
) -> bool {
    messages.into_iter().any(|message| {
        message
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("activity"))
            .is_some_and(activity_labels::step_brings_in_outside_facts)
    })
}

/// The options of the check: the run's own, so its instructions, tools and output form match
/// the requests the provider just cached, on the thread `thread` names. Nothing the turn sent
/// already goes again (images), it must not be required to run a tool, it takes no steer and no
/// wrap-up note, and the turn's continuation note stays the turn's. It answers in words only, on
/// a cancel signal of its own ([`follow_stop`] joins it to the job's), within
/// [`REPLY_CHECK_TIME_LIMIT`]. `None` when that thread cannot be resumed on this runtime: a fresh
/// thread would hold nothing to check against.
pub(super) fn check_run_options(
    run: &CodexRunOptions,
    thread: Option<&JsonValue>,
    usage_observer: Option<UsageCall>,
) -> Option<CodexRunOptions> {
    let mut options = run.clone();
    options.usage_observer = usage_observer;
    options.persist_conversation_thread = true;
    options.provider_conversation_state = Some(thread?.clone());
    options.require_first_tool_call = false;
    options.input_images.clear();
    options.active_turn_input = None;
    options.turn_wrap_up = None;
    options.turn_continue_note = None;
    options.answer_only = Some(AnswerOnly::new());
    // A browser run's time limit cancels its signal; the job's must stay the job's.
    options.cancel_signal = Some(JobCancelSignal::new());
    options.run_timeout = Some(run.hard_limit().min(REPLY_CHECK_TIME_LIMIT));
    options.resumes_provider_thread().then_some(options)
}

/// Cancels the check when the job is: a Stop or a lost lease stops it as it would stop the turn.
/// Dropping the guard ends the watch.
pub(super) struct StopFollower(Option<tokio::task::JoinHandle<()>>);

impl Drop for StopFollower {
    fn drop(&mut self) {
        if let Some(watch) = self.0.take() {
            watch.abort();
        }
    }
}

pub(super) fn follow_stop(job: Option<&JobCancelSignal>, check: &JobCancelSignal) -> StopFollower {
    let Some(job) = job.cloned() else {
        return StopFollower(None);
    };
    if job.is_canceled() {
        check.cancel();
        return StopFollower(None);
    }
    let check = check.clone();
    StopFollower(Some(tokio::spawn(async move {
        job.cancelled().await;
        check.cancel();
    })))
}

/// A browser turn's check runs the turn's browser tools on its own signal. When they could not
/// be confirmed gone, the job's signal says so too, so the browser stays Octo's and the runtime
/// is recycled when the turn ends, as after any browser run whose tools outlived it.
pub(super) fn keep_unconfirmed_browser_shutdown(
    check: &JobCancelSignal,
    job: Option<&JobCancelSignal>,
) {
    if check.shared_browser_shutdown_is_confirmed() {
        return;
    }
    if let Some(job) = job {
        job.reset_shared_browser_shutdown_confirmation();
        job.note_shared_browser_shutdown_failure(
            check
                .shared_browser_shutdown_failure()
                .unwrap_or("run_ended_before_shutdown"),
        );
    }
}

/// Whether a run ended with an answer: a finished message that is not a progress note
/// (`commentary`). A plain-text run would otherwise take a progress note for its reply.
pub(super) fn answered(events: &[JsonValue]) -> bool {
    events.iter().any(|event| {
        event.get("type").and_then(JsonValue::as_str) == Some("item.completed")
            && event.get("item").is_some_and(|item| {
                item.get("type").and_then(JsonValue::as_str) == Some("agent_message")
                    && item.get("phase").and_then(JsonValue::as_str) != Some("commentary")
                    && item
                        .get("text")
                        .and_then(JsonValue::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
            })
    })
}

/// Whether the check ran on the turn's own thread: the same thread, resumed, not a new one.
pub(super) fn resumed_the_turns_thread(
    turn: Option<&JsonValue>,
    check: Option<&JsonValue>,
    browser_mode: bool,
) -> bool {
    let (thread_key, failed_key, source_key) = if browser_mode {
        (
            "browserThreadId",
            "browserThreadRestoreFailed",
            "browserThreadRestoreSource",
        )
    } else {
        (
            "defaultThreadId",
            "defaultThreadRestoreFailed",
            "defaultThreadRestoreSource",
        )
    };
    let thread = |state| {
        provider_state_string(state, thread_key)
            .or_else(|| provider_state_string(state, "threadId"))
    };
    let Some(turn_thread) = thread(turn) else {
        return false;
    };
    thread(check).as_deref() == Some(turn_thread.as_str())
        && !provider_state_bool(check, failed_key).unwrap_or(false)
        && provider_state_string(check, source_key)
            .is_some_and(|source| matches!(source.as_str(), "rollout" | "memory"))
}

/// What became of a check, for the turn's artifacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    /// The reply changed.
    Changed,
    /// The check gave the reply back as it was.
    Unchanged,
    /// The reply stays as it was, for the reason given.
    Kept(&'static str),
}

pub(super) fn artifact(outcome: Outcome, before: &str) -> JsonValue {
    let (outcome, reason) = match outcome {
        Outcome::Changed => ("changed", None),
        Outcome::Unchanged => ("unchanged", None),
        Outcome::Kept(reason) => ("kept", Some(reason)),
    };
    json!({
        "kind": "codex/reply-check",
        "metadata": { "outcome": outcome, "reason": reason },
        "before": before.chars().take(MAX_ARTIFACT_REPLY_CHARS).collect::<String>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::CodexRunOptions;

    fn step(activity: Option<JsonValue>) -> JobMessage {
        JobMessage {
            content: "step".to_string(),
            message_type: Some("command_execution".to_string()),
            metadata: Some(json!({ "activity": activity })),
        }
    }

    #[test]
    fn a_turn_that_read_nothing_is_never_checked() {
        let built = [
            step(activity_labels::file_change_activity(2)),
            step(activity_labels::command_activity(
                None,
                "instafy preview open --title Map --start --json",
            )),
            JobMessage {
                content: "Done.".to_string(),
                message_type: Some("agent_message".to_string()),
                metadata: None,
            },
        ];
        assert!(!turn_read_outside_facts(&built));
        let read = step(activity_labels::command_activity(
            None,
            "instafy web read https://transit.example/lines --json",
        ));
        assert!(turn_read_outside_facts(built.iter().chain([&read])));
    }

    #[test]
    fn the_check_resumes_the_turns_thread_with_its_own_tools_and_nothing_resent() {
        let home = tempfile::tempdir().expect("tmp");
        let rollout = home.path().join("rollout.jsonl");
        std::fs::write(&rollout, "{}\n").expect("rollout");
        let thread = json!({
            "defaultThreadId": "019a0000-0000-7000-8000-000000000001",
            "defaultRolloutPath": rollout.display().to_string(),
        });
        let job = JobCancelSignal::new();
        let run = CodexRunOptions {
            shared_browser: true,
            expect_mcp_tools: true,
            disable_shell_tool: true,
            require_first_tool_call: true,
            persist_conversation_thread: true,
            input_images: vec![home.path().join("photo.png")],
            run_timeout: Some(std::time::Duration::from_secs(600)),
            cancel_signal: Some(job.clone()),
            ..Default::default()
        };
        let check = check_run_options(&run, Some(&thread), None).expect("resumable");
        assert_eq!(check.provider_conversation_state.as_ref(), Some(&thread));
        assert!(check.persist_conversation_thread);
        // The turn's tools: the cached requests had them.
        assert!(check.shared_browser && check.expect_mcp_tools && check.disable_shell_tool);
        assert!(!check.require_first_tool_call);
        assert!(check.input_images.is_empty());
        // A thread this runtime cannot resume holds nothing to check against.
        assert!(check_run_options(&run, None, None).is_none());
        let elsewhere = json!({
            "defaultThreadId": "019a0000-0000-7000-8000-000000000001",
            "defaultRolloutPath": home.path().join("missing.jsonl").display().to_string(),
        });
        assert!(check_run_options(&run, Some(&elsewhere), None).is_none());
    }

    /// The check reads the run instructions its turn read, so on the turn's thread it sends none
    /// again: its requests start as the turn's last one did, and the provider serves that start
    /// from its cache.
    #[test]
    fn the_check_reads_the_run_instructions_its_turn_read() {
        let home = tempfile::tempdir().expect("tmp");
        let rollout = home.path().join("rollout.jsonl");
        std::fs::write(&rollout, "{}\n").expect("rollout");
        let thread = json!({
            "defaultThreadId": "019a0000-0000-7000-8000-000000000001",
            "defaultRolloutPath": rollout.display().to_string(),
            "browserThreadId": "019a0000-0000-7000-8000-000000000002",
            "browserRolloutPath": rollout.display().to_string(),
        });
        let turn = CodexRunOptions {
            persist_conversation_thread: true,
            ..Default::default()
        };
        for run in [
            CodexRunOptions {
                shared_browser: true,
                expect_browser_session: true,
                shared_browser_page_left_by_other_chat: true,
                ..turn.clone()
            },
            CodexRunOptions {
                personal_browser: true,
                expect_browser_session: true,
                ..turn.clone()
            },
            CodexRunOptions {
                expect_browser_session: true,
                ..turn.clone()
            },
            CodexRunOptions {
                disable_final_output_json_schema: true,
                allow_plain_text_final_fallback: true,
                ..turn.clone()
            },
            turn.clone(),
        ] {
            let check = check_run_options(&run, Some(&thread), None).expect("resumable");
            assert_eq!(
                crate::codex::run_instructions_for_options(&check),
                crate::codex::run_instructions_for_options(&run)
            );
        }
    }

    // The check kept the turn's own limit (ten minutes) and the job's own cancel signal, which a
    // browser run's time limit cancels: a check that ran out of time on a browser turn would have
    // ended the finished turn as if its lease was lost, and its reply would never have posted.
    #[test]
    fn the_check_answers_in_words_within_its_own_time_on_its_own_signal() {
        let home = tempfile::tempdir().expect("tmp");
        let rollout = home.path().join("rollout.jsonl");
        std::fs::write(&rollout, "{}\n").expect("rollout");
        let thread = json!({
            "browserThreadId": "019a0000-0000-7000-8000-000000000001",
            "browserRolloutPath": rollout.display().to_string(),
        });
        let job = JobCancelSignal::new();
        let run = CodexRunOptions {
            shared_browser: true,
            expect_browser_session: true,
            persist_conversation_thread: true,
            run_timeout: Some(std::time::Duration::from_secs(600)),
            cancel_signal: Some(job.clone()),
            ..Default::default()
        };
        let check = check_run_options(&run, Some(&thread), None).expect("resumable");
        assert!(
            check
                .answer_only
                .as_ref()
                .is_some_and(|gate| !gate.tried_a_tool())
        );
        assert_eq!(check.run_timeout, Some(REPLY_CHECK_TIME_LIMIT));
        let short = CodexRunOptions {
            run_timeout: Some(std::time::Duration::from_secs(30)),
            ..run.clone()
        };
        assert_eq!(
            check_run_options(&short, Some(&thread), None).and_then(|check| check.run_timeout),
            Some(std::time::Duration::from_secs(30))
        );
        // What ends the check, its time limit included, leaves the job running.
        check
            .cancel_signal
            .as_ref()
            .expect("its own signal")
            .cancel();
        assert!(!job.is_canceled());
    }

    #[tokio::test]
    async fn a_stop_of_the_job_stops_the_check() {
        let (job, check) = (JobCancelSignal::new(), JobCancelSignal::new());
        let follower = follow_stop(Some(&job), &check);
        job.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(5), check.cancelled())
            .await
            .expect("the check stops with the job");
        drop(follower);
        // A job stopped before its check starts stops the check at once.
        let (job, check) = (JobCancelSignal::new(), JobCancelSignal::new());
        job.cancel();
        let _follower = follow_stop(Some(&job), &check);
        assert!(check.is_canceled());
        // Once the check is over, a later Stop is the job's alone.
        let (job, check) = (JobCancelSignal::new(), JobCancelSignal::new());
        drop(follow_stop(Some(&job), &check));
        job.cancel();
        tokio::task::yield_now().await;
        assert!(!check.is_canceled());
    }

    #[test]
    fn a_browser_check_whose_tools_outlived_it_keeps_the_browser_octos() {
        let (job, check) = (JobCancelSignal::new(), JobCancelSignal::new());
        job.confirm_shared_browser_shutdown();
        check.confirm_shared_browser_shutdown();
        keep_unconfirmed_browser_shutdown(&check, Some(&job));
        assert!(job.shared_browser_shutdown_is_confirmed());

        let check = JobCancelSignal::new();
        check.note_shared_browser_shutdown_failure("mcp_processes_not_gone");
        keep_unconfirmed_browser_shutdown(&check, Some(&job));
        assert!(!job.shared_browser_shutdown_is_confirmed());
        assert_eq!(
            job.shared_browser_shutdown_failure(),
            Some("mcp_processes_not_gone")
        );
    }

    #[test]
    fn only_an_answer_counts_as_the_checks_words() {
        let message = |phase: Option<&str>, text: &str| {
            let mut item = json!({"id": "m", "type": "agent_message", "text": text});
            if let Some(phase) = phase {
                item["phase"] = json!(phase);
            }
            json!({"type": "item.completed", "item": item})
        };
        assert!(answered(&[message(Some("final_answer"), "Not checked.")]));
        assert!(answered(&[message(None, "Not checked.")]));
        // A progress note alone is no answer, and neither is reasoning.
        assert!(!answered(&[message(
            Some("commentary"),
            "Checking the reply."
        )]));
        assert!(!answered(&[message(Some("final_answer"), "  ")]));
        assert!(!answered(&[
            json!({"type": "item.completed", "item": {"id": "r", "type": "reasoning", "text": "x"}})
        ]));
    }

    #[test]
    fn only_a_resume_of_the_same_thread_counts() {
        let turn = json!({ "browserThreadId": "a", "browserRolloutPath": "/r" });
        let resumed = json!({
            "browserThreadId": "a", "browserThreadRestoreFailed": false,
            "browserThreadRestoreSource": "rollout",
        });
        assert!(resumed_the_turns_thread(Some(&turn), Some(&resumed), true));
        let fresh = json!({
            "browserThreadId": "b", "browserThreadRestoreFailed": true,
            "browserThreadRestoreSource": "failed_new",
        });
        assert!(!resumed_the_turns_thread(Some(&turn), Some(&fresh), true));
        let same_id_failed = json!({
            "browserThreadId": "a", "browserThreadRestoreFailed": true,
            "browserThreadRestoreSource": "failed_new",
        });
        assert!(!resumed_the_turns_thread(
            Some(&turn),
            Some(&same_id_failed),
            true
        ));
        // The default thread is not the browser thread.
        assert!(!resumed_the_turns_thread(
            Some(&turn),
            Some(&resumed),
            false
        ));
        assert!(!resumed_the_turns_thread(None, Some(&resumed), true));
    }

    #[test]
    fn the_prompt_says_the_three_rules_and_keeps_the_rest_of_the_reply() {
        for rule in [
            "Mark every fact in it that no page read for this turn states as \"not checked\", or take it out.",
            "Never say a place, stop, route or time doesn't exist unless a page read for this turn says so.",
            "Take out any step you say you are taking that this turn didn't start",
            "Use no tool for this.",
            "with the same files, suggestions and actions",
        ] {
            assert!(REPLY_CHECK_PROMPT.contains(rule), "{rule}");
        }
    }
}
