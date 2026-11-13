//! A local-engine turn inside the job processor (docs/Local-Engine-Turns.md 3.1 and 3.7): it never
//! reaches the embedded engine's turn, an engine this runtime does not know runs nothing, its tool
//! steps get the lane's own labels, and its steps stream through the handler every turn shares.

use super::tests::{test_job_processor, test_lease_job, test_registration_with_proxy};
use super::*;

fn lane_job() -> LeaseJob {
    let mut job = test_lease_job(
        Some("feature"),
        json!({
            "prompt_text": "Rename the project in README.md",
            "metadata": { "input": { "kind": "person" } },
        }),
    );
    job.engine = Some("claude-code".to_string());
    job
}

/// Runs `work` on a thread with the production worker's stack: the embedded engine's turn is a
/// future far too large for a test's own stack.
fn on_a_worker_stack<F: std::future::Future<Output = ()> + Send + 'static>(work: F) {
    const WORKER_STACK: usize = 16 * 1024 * 1024;
    std::thread::Builder::new()
        .stack_size(WORKER_STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(work)
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn the_embedded_engines_turn_refuses_a_local_engine_job_on_its_first_line() {
    on_a_worker_stack(the_embedded_engines_turn_refuses_a_local_engine_job());
}

async fn the_embedded_engines_turn_refuses_a_local_engine_job() {
    let temp = tempfile::tempdir().expect("workspaces");
    let processor = test_job_processor(temp.path());
    let registration = test_registration_with_proxy();
    for engine in ["claude-code", "another-engine"] {
        let mut job = lane_job();
        job.engine = Some(engine.to_string());
        let turn_files = turn_continuation::TurnFiles::for_job(&job);
        let turn_start = stopped_turn::TurnStart::default();
        let left_thread = LeftThread::default();
        let task_usage = TaskUsage::default();
        let error = Box::pin(processor.run_apply_job_observed(
            &registration,
            &job,
            true,
            None,
            None,
            None,
            &task_usage,
            &turn_files,
            &turn_start,
            &left_thread,
        ))
        .await
        .expect_err("refused");
        turn_files.remove();
        assert!(
            error
                .to_string()
                .contains("never runs on the embedded engine"),
            "{error:#}"
        );
        // Nothing of the space was touched: not even its folder was made.
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn an_unknown_engine_runs_nothing() {
    let temp = tempfile::tempdir().expect("workspaces");
    let processor = test_job_processor(temp.path());
    let mut job = lane_job();
    job.engine = Some("another-engine".to_string());
    let error = processor
        .run_apply_job(
            &test_registration_with_proxy(),
            &job,
            true,
            None,
            None,
            None,
        )
        .await
        .expect_err("refused");
    assert!(error.to_string().contains("another-engine"), "{error:#}");
    assert!(!crate::agent_executor::is_lease_lost(&error));
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn a_local_engine_turns_tool_steps_have_the_lanes_own_labels() {
    let step = |tool: &str| {
        let events = vec![json!({
            "type": "item.completed",
            "item": {
                "id": format!("toolu_{tool}"),
                "type": "mcp_tool_call",
                "server": crate::claude_code::events::TOOL_SERVER,
                "tool": tool,
                "status": "completed",
                "engine": crate::claude_code::job::ENGINE,
            }
        })];
        let messages = extract_codex_messages(&events);
        assert_eq!(messages.len(), 1, "{tool}");
        messages[0].metadata.clone().unwrap()["activity"].clone()
    };
    assert_eq!(step("Read")["key"], "builtin/look");
    assert_eq!(step("Grep")["live"], "Looking through files");
    assert_eq!(step("WebFetch")["key"], "instafy/web-read");
    assert_eq!(step("Agent")["key"], "tool/use");
    assert_eq!(step("Task")["key"], "tool/use");
    // Another server's tool keeps the label it had.
    let events = vec![json!({
        "type": "item.completed",
        "item": { "id": "call", "type": "mcp_tool_call", "server": "github", "tool": "Read",
                  "status": "completed" }
    })];
    let other = extract_codex_messages(&events);
    assert_eq!(
        other[0].metadata.as_ref().unwrap().get("activity"),
        activity_labels::mcp_tool_activity("github").as_ref()
    );
}

/// A Codex turn whose configuration names an MCP server `claude-code` (`claude mcp serve`) keeps
/// the label any server's tool gets: only the lane's own steps, which carry its mark, get the
/// lane's table (regression-1).
#[test]
fn a_codex_turns_mcp_server_named_claude_code_keeps_the_tool_label() {
    for tool in ["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch"] {
        let events = vec![json!({
            "type": "item.completed",
            "item": { "id": format!("call_{tool}"), "type": "mcp_tool_call",
                      "server": "claude-code", "tool": tool, "status": "completed" }
        })];
        let messages = extract_codex_messages(&events);
        assert_eq!(messages.len(), 1, "{tool}");
        let activity = messages[0].metadata.as_ref().unwrap().get("activity");
        assert_eq!(
            activity,
            activity_labels::mcp_tool_activity("claude-code").as_ref(),
            "{tool}"
        );
        assert_ne!(
            activity.and_then(|activity| activity.get("key")),
            Some(&json!("builtin/look")),
            "{tool}"
        );
    }
    // A mark of another engine is no lane step either.
    let events = vec![json!({
        "type": "item.completed",
        "item": { "id": "call", "type": "mcp_tool_call", "server": "claude-code",
                  "tool": "Read", "status": "completed", "engine": "another-engine" }
    })];
    let messages = extract_codex_messages(&events);
    assert_eq!(
        messages[0].metadata.as_ref().unwrap().get("activity"),
        activity_labels::mcp_tool_activity("claude-code").as_ref()
    );
}

#[test]
fn the_shared_streaming_handler_sends_each_new_step_once_until_the_chat_stops_taking_them() {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let progress = JobProgress {
        sender,
        status: Arc::new(AtomicBool::new(true)),
        reply_draft: None,
    };
    let mut steps = StepStream::of(&progress);
    let runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let command = |id: &str, status: &str| {
        json!({
            "type": if status == "in_progress" { "item.started" } else { "item.completed" },
            "item": { "id": id, "type": "command_execution", "command": "npm test",
                      "aggregated_output": "", "exit_code": null, "status": status }
        })
    };
    for event in [command("a", "in_progress"), command("a", "completed")] {
        stream_turn_event(
            &event,
            None,
            Some(&mut steps),
            &extract_codex_messages,
            &runtime_id,
            job_id,
        );
    }
    let sent: Vec<JobMessage> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent[0].metadata.as_ref().unwrap()["runtimeId"],
        json!(runtime_id.to_string())
    );
    assert!(steps.all_streamed());
    // A chat that no longer takes them: streaming stops, and the turn says not every step was
    // sent, so its completion sends them again.
    drop(receiver);
    stream_turn_event(
        &command("b", "in_progress"),
        None,
        Some(&mut steps),
        &extract_codex_messages,
        &runtime_id,
        job_id,
    );
    assert!(!steps.all_streamed());
    assert_eq!(steps.events.len(), 3);
}

/// A turn that left programs running says how many the runtime stopped (3.6), in a status step
/// of its own; a turn that left none says nothing.
#[test]
fn a_turn_says_how_many_programs_it_left_running_were_stopped() {
    assert!(claude_code_turn::programs_stopped_step(0).is_none());
    let one = claude_code_turn::programs_stopped_step(1).expect("a step");
    assert_eq!(
        one.content,
        "Claude Code left 1 program running when it finished; Instafy stopped it."
    );
    assert_eq!(one.message_type.as_deref(), Some("status"));
    let metadata = one.metadata.expect("metadata");
    assert_eq!(metadata["kind"], "claude_code_programs_stopped");
    assert_eq!(metadata["count"], 1);
    assert_eq!(
        metadata["presentation"],
        json!({ "placement": "reply_note" })
    );
    let three = claude_code_turn::programs_stopped_step(3).expect("a step");
    assert_eq!(
        three.content,
        "Claude Code left 3 programs running when it finished; Instafy stopped them."
    );
    assert_eq!(three.metadata.expect("metadata")["count"], 3);
}

/// Every note of a local-engine turn is a status step Studio shows under the reply once the turn
/// is done, Details closed or not: its metadata carries the generic placement, which the
/// controller keeps under `details` (xpc-notes-1), beside the note's own keys.
#[test]
fn a_turns_notes_carry_the_reply_note_placement() {
    let note = claude_code_turn::status_step(
        "Claude Code's changes stayed on this computer and weren't saved to the space.".into(),
        "claude_code_changes_not_saved",
        json!({ "reason": "save_failed", "paths": ["README.md"] }),
    );
    assert_eq!(note.message_type.as_deref(), Some("status"));
    assert_eq!(
        note.metadata,
        Some(json!({
            "kind": "claude_code_changes_not_saved",
            "presentation": { "placement": "reply_note" },
            "reason": "save_failed",
            "paths": ["README.md"],
        }))
    );
    let bare = claude_code_turn::status_step("Held.".into(), "claude_code_held_pages", json!({}));
    assert_eq!(
        bare.metadata,
        Some(json!({
            "kind": "claude_code_held_pages",
            "presentation": { "placement": "reply_note" },
        }))
    );
    assert_eq!(
        crate::claude_code::events::reply_note(),
        json!({ "placement": crate::claude_code::events::REPLY_NOTE_PLACEMENT })
    );
}
