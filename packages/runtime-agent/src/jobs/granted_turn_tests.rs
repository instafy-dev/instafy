//! A leased job that holds device grants: the turn it gets, the prompt it reads, and the
//! ordinary lanes and retries it never enters.

use super::tests::{test_job_processor, test_lease_job, test_registration_with_proxy};
use super::*;
use crate::provider_mcp::tests::leased_grant;

fn granted_job() -> LeaseJob {
    let mut job = test_lease_job(
        Some("apply"),
        json!({
            "prompt_text": "Read the state.",
            "metadata": {},
        }),
    );
    job.run_id = Some(Uuid::new_v4());
    job.grants = vec![leased_grant()];
    job.grant_token = Some(crate::controller::GrantToken("grant-token".to_string()));
    job
}

fn ordinary(job: &LeaseJob) -> LeaseJob {
    let mut job = job.clone();
    job.grants.clear();
    job
}

#[test]
fn a_job_holding_grants_runs_as_a_granted_turn_of_the_processors_broker() {
    let temp = tempfile::tempdir().expect("workspaces");
    let processor = test_job_processor(temp.path())
        .with_provider_mcp_program(PathBuf::from("/trusted/runtime-agent"));
    let project_id = Uuid::new_v4();

    let job = granted_job();
    let turn = processor
        .granted_turn(&job, project_id)
        .expect("a usable grant")
        .expect("a granted turn");
    assert_eq!(turn.project_id, project_id);
    assert_eq!(turn.broker_program, PathBuf::from("/trusted/runtime-agent"));
    assert_eq!(
        turn.controller_base_url,
        processor.config.controller_base_url
    );
    assert_eq!(turn.token.0, "grant-token");

    // One that may use none of its grants fails, and its failure, the error's outermost
    // message, says why.
    let mut stopped = granted_job();
    stopped.grants[0].refused = Some("the device is stopped".to_string());
    let error = processor
        .granted_turn(&stopped, project_id)
        .expect_err("no usable grant");
    assert_eq!(
        error.to_string(),
        "this turn may use none of its device grants: the device is stopped"
    );
}

#[test]
fn a_granted_job_skips_the_routing_preflight_and_every_command_obligation() {
    let granted = granted_job();
    let plain = ordinary(&granted);
    let prompt = "Check the state and tell me if the lid is open.";
    assert!(should_run_agent_routing_preflight_for_execution(
        &plain, prompt
    ));
    assert!(!should_run_agent_routing_preflight_for_execution(
        &granted, prompt
    ));

    // Stale or client metadata cannot give a granted turn a file or command obligation.
    let demanding = json!({
        "runtimeExpectations": {
            "workspaceFileChanges": true,
            "commandExecution": true,
            "genericMcpToolExecution": true,
        },
        "agentRoutingPreflight": { "requiresContextLookup": true },
    });
    let mut granted_demanding = granted.clone();
    let mut plain_demanding = plain.clone();
    for job in [&mut granted_demanding, &mut plain_demanding] {
        job.payload["metadata"] = demanding.clone();
    }
    let granted_expectations = runtime_job_expectations_for_execution(
        &granted_demanding.payload,
        is_bounded_job(&granted_demanding),
    );
    assert_eq!(granted_expectations, RuntimeJobExpectations::default());
    assert!(
        !routing_evidence_requirements(&granted_demanding, granted_expectations).requires_any()
    );
    let plain_expectations = runtime_job_expectations_for_execution(
        &plain_demanding.payload,
        is_bounded_job(&plain_demanding),
    );
    assert!(plain_expectations.command_execution);
    assert!(routing_evidence_requirements(&plain_demanding, plain_expectations).requires_any());

    // Nor a command lane.
    let workspace = tempfile::tempdir().expect("workspace");
    for prompt in [
        "/terminal env",
        "/learn apply",
        "/mcp list",
        "/skills list",
        "/sync status",
    ] {
        let mut job = granted.clone();
        job.payload["prompt_text"] = json!(prompt);
        assert!(
            ensure_bounded_job_uses_bounded_lane(&job, prompt, workspace.path()).is_err(),
            "a granted job entered {prompt}"
        );
    }
}

#[test]
fn a_granted_turn_answers_in_strict_json_whatever_its_metadata_asks() {
    let granted = granted_job();
    let plain = ordinary(&granted);
    for (key, value) in [
        (
            "replyContext",
            json!({ "kind": "message_selection", "action": "summarize", "selectedText": "the lid" }),
        ),
        (
            "replyContext",
            json!({ "kind": "message_selection", "action": "explain_more", "selectedText": "the lid" }),
        ),
        (
            "agentCollaboration",
            json!({ "requested": true, "mode": "team_plan" }),
        ),
    ] {
        let mut granted_asking = granted.clone();
        let mut plain_asking = plain.clone();
        for job in [&mut granted_asking, &mut plain_asking] {
            job.payload["metadata"][key] = value.clone();
        }
        let mode = |job: &LeaseJob| {
            final_output_mode_for_runtime_job(job, false, RuntimeJobExpectations::default())
        };
        assert_ne!(
            mode(&plain_asking),
            RuntimeFinalOutputMode::StrictStructured,
            "an ordinary turn takes {key} {value}"
        );
        assert_eq!(
            mode(&granted_asking),
            RuntimeFinalOutputMode::StrictStructured,
            "a granted turn ignores {key} {value}"
        );
    }
}

#[test]
fn a_granted_job_never_takes_a_parallel_worker_path_that_skips_its_checks() {
    let temp = tempfile::tempdir().expect("workspaces");
    let processor = test_job_processor(temp.path());
    let registration = test_registration_with_proxy();
    let mut job = granted_job();
    let metadata = job.payload["metadata"].as_object_mut().unwrap();
    metadata.insert(
        "multiAgentPlan".to_string(),
        json!({ "role": "worker", "groupId": "group-1" }),
    );
    metadata.insert(
        "writeScope".to_string(),
        json!({ "mode": "owned", "ownedPaths": ["tmp/alpha.txt"] }),
    );
    assert!(processor.parallel_scoped_scope_paths(&job).is_some());
    assert!(!processor.can_run_parallel_scoped_worker(&registration, &job));
    assert!(processor.can_run_parallel_scoped_worker(&registration, &ordinary(&job)));
}

#[test]
fn a_granted_turns_prompt_is_its_conversation_and_request_and_nothing_else() {
    let mut job = granted_job();
    job.payload["conversation_history"] = json!([
        { "role": "user", "content": "the red lid is the one on the left" },
        { "role": "assistant", "content": "Noted." },
    ]);
    let (prompt, metrics) = granted_turn_prompt(&job, "  Is the lid open? ", None);
    assert!(
        prompt.contains("the red lid is the one on the left"),
        "{prompt}"
    );
    assert!(
        prompt.ends_with("Latest user request:\nIs the lid open?"),
        "{prompt}"
    );
    assert!(prompt.contains("\"summary\""), "{prompt}");
    assert!(!prompt.contains("Project preferences snapshot"), "{prompt}");
    assert_eq!(metrics["promptMode"], json!("granted"));
}

#[test]
fn a_granted_turn_never_asks_to_open_a_browser() {
    let card = || {
        CodexAction::RequestBrowser(
            browser_request::BrowserRequest::parse(
                json!({"task": "Open https://example.com/pricing and read the team plan."})
                    .as_object()
                    .unwrap(),
            )
            .unwrap(),
        )
    };
    let outcome_with_card = || CodexOutcome {
        summary: "Instafy's browser will open the pricing page.".to_string(),
        suggested_replies: Vec::new(),
        files: Vec::new(),
        read_files: Vec::new(),
        snippet: None,
        actions: vec![card()],
    };
    let granted = granted_job();
    let mut outcome = outcome_with_card();
    suppress_browser_requests_where_unsupported(&granted, &mut outcome);
    assert!(outcome.actions.is_empty());
    let mut outcome = outcome_with_card();
    suppress_browser_requests_where_unsupported(&ordinary(&granted), &mut outcome);
    assert_eq!(outcome.actions.len(), 1);
}

#[test]
fn a_granted_job_is_never_a_browser_turn_nor_in_browser_mode() {
    let granted = granted_job();
    for transport in ["desktop-personal", "shared"] {
        let mut job = granted.clone();
        job.payload["metadata"]["browserTransport"] = json!(transport);
        let error = turn_browser_mode(&job, false).expect_err("a granted browser turn");
        assert!(
            error.to_string().contains("cannot also be a browser turn"),
            "{transport}: {error}"
        );
        assert!(turn_browser_mode(&ordinary(&job), false).expect("a browser turn"));
    }
    // On a runtime that hosts a browser session, every other turn runs in browser mode.
    assert!(!turn_browser_mode(&granted, true).expect("a granted turn"));
    assert!(turn_browser_mode(&ordinary(&granted), true).expect("an ordinary turn"));
}
