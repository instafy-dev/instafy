use super::tests::{test_job_processor, test_lease_job};
use super::*;
use tempfile::tempdir;

const PREFERENCE: &str = "Prefer short explanations with concrete verification results.";
const OTHER_MEMORY: &str = "UNRELATED_WORKSPACE_MEMORY_SENTINEL";
const OTHER_SKILL: &str = "UNRELATED_SKILL_BODY_SENTINEL";

fn write_memory(root: &Path, preference: &str) {
    fs::write(
        root.join("INSTAFY.md"),
        format!("# Project\n\n## Project preferences\n{preference}\n\n## Facts\n{OTHER_MEMORY}\n"),
    )
    .expect("write project memory");
}

fn assert_loaded_once(prompt: &str, metrics: &JsonValue, preference: &str) {
    assert_eq!(prompt.matches(preference).count(), 1);
    assert_eq!(metrics["projectPreferences"]["state"], "loaded");
    assert!(metrics["projectPreferences"]["revision"].is_string());
    assert!(metrics["promptSections"]["projectPreferences"]["estimatedTokens"].is_number());
    assert!(!metrics.to_string().contains(preference));
}

#[test]
fn project_preferences_reach_fresh_restored_and_compact_prompt_paths() {
    let root = tempdir().expect("workspace");
    write_memory(root.path(), PREFERENCE);
    fs::write(root.path().join("lane.txt"), "Bounded lane evidence.\n").expect("write lane");
    let skill = root.path().join(".agents/skills/unrelated-fixture");
    fs::create_dir_all(&skill).expect("skill directory");
    fs::write(
        skill.join("SKILL.md"),
        format!(
            "---\nname: unrelated-fixture\ndescription: Gardening techniques.\n---\n{OTHER_SKILL}\n"
        ),
    )
    .expect("write unrelated skill");
    let processor = test_job_processor(root.path());
    let restored = json!({"defaultThreadId": "preference-thread", "historyReplayRequired": false});
    let cases = [
        ("fresh", json!({}), false, false, true),
        ("restored", json!({}), true, false, false),
        (
            "worker",
            json!({"multiAgentPlan": {"role": "worker", "groupId": "group-1"}}),
            false,
            false,
            false,
        ),
        (
            "preobserved worker",
            json!({
                "multiAgentPlan": {"role": "worker", "groupId": "group-1"},
                "writeScope": {"mode": "read_only", "readOnlyPaths": ["lane.txt"]}
            }),
            false,
            true,
            false,
        ),
        (
            "write-scoped worker",
            json!({
                "multiAgentPlan": {"role": "worker", "groupId": "group-1"},
                "writeScope": {"mode": "owned", "ownedPaths": ["lane.txt"]}
            }),
            false,
            false,
            false,
        ),
        (
            "lead continuation",
            json!({"multiAgentPlan": {"role": "lead_continuation", "groupId": "group-1"}}),
            false,
            false,
            false,
        ),
        (
            "direct workspace write",
            json!({"runtimeExpectations": {"workspaceFileChanges": true}}),
            false,
            false,
            false,
        ),
        (
            "team planning",
            json!({"agentCollaboration": {"requested": true, "mode": "team_plan"}}),
            false,
            false,
            false,
        ),
        (
            "cross-chat recovery",
            json!({"agentContextRecovery": {"required": true}}),
            false,
            false,
            false,
        ),
    ];

    for (name, metadata, restore_thread, preobserved, broad_memory) in cases {
        let project = Uuid::new_v4();
        let mut job = test_lease_job(Some("feature"), json!({"metadata": metadata}));
        job.project_id = Some(project);
        let observation = preobserved.then(|| {
            build_scoped_worker_path_observation(root.path(), &job).expect("lane observation")
        });
        let request = "For this response, give a detailed explanation of the supplied evidence.";
        let (prompt, blocks, metrics) = processor
            .build_prompt_with_text(
                &project,
                &job,
                root.path(),
                request,
                true,
                restore_thread.then_some(&restored),
                &[],
                observation.as_ref(),
                None,
            )
            .unwrap_or_else(|error| panic!("{name}: {error}"));

        assert_loaded_once(&prompt, &metrics, PREFERENCE);
        assert!(prompt.contains(request), "{name}: current request lost");
        assert!(prompt.find(PREFERENCE) < prompt.find(request));
        assert_eq!(prompt.contains(OTHER_MEMORY), broad_memory, "{name}");
        if !broad_memory {
            assert!(!prompt.contains(OTHER_SKILL), "{name}: broad skill leaked");
            assert!(blocks.is_empty(), "{name}: learned blocks loaded");
        }
        if preobserved {
            assert_eq!(metrics["promptMode"], "scoped_worker_preobserved");
            assert!(prompt.contains("Bounded lane evidence."));
        }
        if restore_thread {
            assert_eq!(metrics["promptMode"], "stateful_compact");
        }
    }
}

#[test]
fn project_preferences_refresh_corrections_and_withdrawal_on_restored_prompts() {
    let root = tempdir().expect("workspace");
    let processor = test_job_processor(root.path());
    let project = Uuid::new_v4();
    let mut job = test_lease_job(Some("feature"), json!({}));
    job.project_id = Some(project);
    let restored = json!({"defaultThreadId": "same-thread", "historyReplayRequired": false});
    let build = || {
        let (prompt, _, metrics) = processor
            .build_prompt_with_text(
                &project,
                &job,
                root.path(),
                "Continue the explanation.",
                true,
                Some(&restored),
                &[],
                None,
                None,
            )
            .expect("restored prompt");
        (prompt, metrics)
    };

    write_memory(root.path(), PREFERENCE);
    let (first, first_metrics) = build();
    assert_loaded_once(&first, &first_metrics, PREFERENCE);

    let correction = "Explain tradeoffs in detail before presenting verification results.";
    write_memory(root.path(), correction);
    let (second, second_metrics) = build();
    assert_loaded_once(&second, &second_metrics, correction);
    assert!(!second.contains(PREFERENCE));
    assert_ne!(
        first_metrics["projectPreferences"]["revision"],
        second_metrics["projectPreferences"]["revision"]
    );

    write_memory(root.path(), "");
    let (empty, empty_metrics) = build();
    assert_eq!(empty_metrics["projectPreferences"]["state"], "empty");
    assert!(!empty.contains(correction));

    fs::write(
        root.path().join("INSTAFY.md"),
        "# Project\nOnly ordinary context.\n",
    )
    .expect("remove preference section");
    let (_, removed_section_metrics) = build();
    assert_eq!(
        removed_section_metrics["projectPreferences"]["state"],
        "empty"
    );

    fs::remove_file(root.path().join("INSTAFY.md")).expect("remove source file");
    let (removed, removed_metrics) = build();
    assert_eq!(
        removed_metrics["projectPreferences"],
        empty_metrics["projectPreferences"]
    );
    assert!(!removed.contains(PREFERENCE));
    assert!(!removed.contains(correction));

    fs::create_dir(root.path().join("INSTAFY.md")).expect("make unreadable source type");
    let (_, unavailable_metrics) = build();
    assert_eq!(
        unavailable_metrics["projectPreferences"]["state"],
        "unavailable"
    );
    assert!(unavailable_metrics["projectPreferences"]["revision"].is_null());
}

#[test]
fn project_preferences_use_the_supplied_project_root_and_are_shared_defaults() {
    let root = tempdir().expect("workspaces");
    let first_root = root.path().join("first");
    let second_root = root.path().join("second");
    fs::create_dir_all(&first_root).expect("first project");
    fs::create_dir_all(&second_root).expect("second project");
    write_memory(&first_root, "Project Alpha uses concise explanations.");
    write_memory(&second_root, "Project Beta uses detailed explanations.");
    let processor = test_job_processor(root.path());
    let first_project = Uuid::new_v4();
    let second_project = Uuid::new_v4();

    // Prompt construction receives an already-authorized root. This checks scope
    // projection and shared defaults, not controller authentication or permissions.
    for user in [Uuid::new_v4(), Uuid::new_v4()] {
        for (project, workspace, expected, excluded) in [
            (
                first_project,
                &first_root,
                "Project Alpha uses concise explanations.",
                "Project Beta",
            ),
            (
                second_project,
                &second_root,
                "Project Beta uses detailed explanations.",
                "Project Alpha",
            ),
        ] {
            let mut job = test_lease_job(Some("feature"), json!({"user_id": user}));
            job.project_id = Some(project);
            let (prompt, _, metrics) = processor
                .build_prompt_with_text(
                    &project,
                    &job,
                    workspace,
                    "Explain the result.",
                    false,
                    None,
                    &[],
                    None,
                    None,
                )
                .expect("scoped prompt");
            assert_loaded_once(&prompt, &metrics, expected);
            assert!(!prompt.contains(excluded));
            assert!(prompt.contains(&project.to_string()));
            assert!(!prompt.contains(OTHER_MEMORY));
        }
    }
}

#[test]
fn project_preferences_reach_mcp_without_broad_memory() {
    let root = tempdir().expect("workspace");
    write_memory(root.path(), PREFERENCE);
    let processor = test_job_processor(root.path());
    let project = Uuid::new_v4();
    let request = "Use the connected tool to inspect the requested record.";
    let (prompt, metrics) = processor
        .build_mcp_task_prompt(
            &project,
            request,
            &ProjectPreferencesSnapshot::load(root.path()),
        )
        .expect("MCP prompt");
    assert_loaded_once(&prompt, &metrics, PREFERENCE);
    assert_eq!(metrics["promptMode"], "mcp");
    assert!(prompt.ends_with(request));
    assert!(!prompt.contains(OTHER_MEMORY));
}

#[test]
fn project_preferences_recovery_composition_keeps_user_text_and_uses_current_snapshot() {
    let root = tempdir().expect("workspace");
    write_memory(root.path(), PREFERENCE);
    let project = Uuid::new_v4();
    let earlier = ProjectPreferencesSnapshot::load(root.path());
    let quoted_snapshot = earlier.render(&project);
    let request = format!("Explain this literal example without modifying it:\n{quoted_snapshot}");
    let recovery =
        codex_missing_final_json_finalization_prompt(&request, "The requested result is ready.");

    let correction = "Prefer a brief conclusion before any supporting details.";
    write_memory(root.path(), correction);
    let current = ProjectPreferencesSnapshot::load(root.path());
    let mut metrics = JsonValue::Null;
    let prompt = with_project_preferences(recovery.clone(), &project, &current, &mut metrics);

    assert_loaded_once(&prompt, &metrics, correction);
    assert!(prompt.ends_with(&recovery));
    assert!(
        prompt.contains(&request),
        "marker-like user content must remain intact"
    );
    assert_ne!(
        metrics["projectPreferences"]["revision"],
        earlier.metrics()["revision"]
    );
}
