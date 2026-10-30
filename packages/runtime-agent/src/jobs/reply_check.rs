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
//! [`REPLY_CHECK_PROMPT`], with no tool use. It runs with the turn's own instructions and tools,
//! so the provider serves the whole thread from its cache and only the short prompt and the reply
//! are new (about one credit on a long browser turn at the managed rates). Its reply replaces the
//! turn's words only; the turn's files, cards and suggestions stay as they were. A turn that read
//! nothing is never checked, and a check that cannot resume the turn's thread, fails, uses a tool
//! or answers with nothing usable leaves the reply as it was.

use serde_json::{Value as JsonValue, json};

use super::{JobMessage, activity_labels, provider_state_bool, provider_state_string};
use crate::codex::CodexRunOptions;
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
/// wrap-up note, and the turn's continuation note stays the turn's. `None` when that thread
/// cannot be resumed on this runtime: a fresh thread would hold nothing to check against.
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
    options.resumes_provider_thread().then_some(options)
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

/// Whether a run started anything but its own words: a command, a file change, a tool call or a
/// web search. The check is told to use none; one that did is not the reply's check.
pub(super) fn run_used_a_tool(events: &[JsonValue]) -> bool {
    events.iter().any(|event| {
        let started = event
            .get("type")
            .and_then(JsonValue::as_str)
            .is_some_and(|kind| kind == "item.started" || kind == "item.completed");
        started
            && event
                .get("item")
                .and_then(|item| item.get("type"))
                .and_then(JsonValue::as_str)
                .is_some_and(|kind| {
                    !matches!(kind, "agent_message" | "reasoning" | "todo_list" | "error")
                })
    })
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
        let run = CodexRunOptions {
            shared_browser: true,
            expect_mcp_tools: true,
            disable_shell_tool: true,
            require_first_tool_call: true,
            persist_conversation_thread: true,
            input_images: vec![home.path().join("photo.png")],
            run_timeout: Some(std::time::Duration::from_secs(600)),
            ..Default::default()
        };
        let check = check_run_options(&run, Some(&thread), None).expect("resumable");
        assert_eq!(check.provider_conversation_state.as_ref(), Some(&thread));
        assert!(check.persist_conversation_thread);
        // The turn's tools and limits: the cached requests had them.
        assert!(check.shared_browser && check.expect_mcp_tools && check.disable_shell_tool);
        assert_eq!(check.run_timeout, run.run_timeout);
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
    fn a_check_that_ran_a_tool_is_not_the_replys_check() {
        let said = |kind: &str| json!({"type": "item.completed", "item": {"id": "i", "type": kind, "text": "x"}});
        assert!(!run_used_a_tool(&[
            json!({"type": "turn.started"}),
            said("reasoning"),
            said("agent_message"),
            json!({"type": "turn.completed", "usage": {}}),
        ]));
        for kind in [
            "command_execution",
            "mcp_tool_call",
            "file_change",
            "web_search",
        ] {
            assert!(
                run_used_a_tool(&[
                    json!({"type": "item.started", "item": {"id": "t", "type": kind}}),
                    said("agent_message"),
                ]),
                "{kind}"
            );
        }
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
