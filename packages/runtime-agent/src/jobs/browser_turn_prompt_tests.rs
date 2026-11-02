//! A browser turn is given only what it can use. Its only tools are its browser's, so its prompt
//! says nothing of running a command, changing a file, or starting a team plan or a goal, and it
//! loads none of the skills that build, run commands or plan a team. A local test (Nov 1): a
//! browser turn's first prompt was about 77,000 characters, with the map skill's commands and the
//! collaboration skill's team planning in it; one turn sent a map request looked for a shell,
//! answered "the required workspace command tool isn't available" with a team plan, and two
//! research turns looked for a shell after a page. Its browser skill was cut at 12,000 bytes,
//! mid-line, so no browser turn read its second half. A building turn keeps every line.

use super::tests::{test_job_processor, test_lease_job};
use super::*;
use tempfile::tempdir;

const BROWSER_SKILL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-browser-automation/SKILL.md"
));
const BROWSER_SKILL_REFERENCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-browser-automation/references/learning-and-local-browsers.md"
));
const BROWSER_SKILL_HEADING: &str =
    "## Context: instafy-browser-automation (.agents/skills/instafy-browser-automation/SKILL.md)";

/// A request that names the browser, a fact the research skill covers and a trip, which a
/// skill that builds trips claims by its words: the router routes both.
const REQUEST: &str = "In your browser, find the opening hours and the official site of Livraria Lello for my trip itinerary.";

/// What a first prompt says about running commands, changing files, team plans and goals.
const FIRST_PROMPT_WORKSPACE_LINES: &[&str] = &[
    "When a repo is imported or cloned into a subdirectory",
    "Do not run package-manager install commands",
    "call the available runtime command tool (`exec_command` or `shell`) before returning the final JSON",
    "If no command tool is callable, return a JSON `summary` that states that concrete blocker.",
    "avoid re-reading it via shell commands",
    "Avoid exploratory commands (especially `--help` output dumps).",
    "retrieve it via the Instafy CLI",
    "Do not call controller APIs with curl/wget",
    "- { type: 'multi_agent_plan',",
    "- { type: 'goal_update',",
    "Sibling lanes must be self-contained at start.",
    "instafy conversation show --include-threads --transcript --json",
    "If the user asks you to create/edit/delete files, you MUST actually perform the filesystem changes",
    "If you cannot apply file changes via tools, you MUST include the full post-change contents inline",
    "If you use `apply_patch`, follow the patch format exactly.",
    "Populate `files` with any workspace files you changed",
    "retrieve it (do not guess) via `instafy history messages`",
    "When the request depends on observable workspace, runtime, repo, process, or server state",
    "Active conversation goal:",
];

/// What a restored thread's reminder says about them.
const REMINDER_WORKSPACE_LINES: &[&str] = &[
    "Populate `files` only for real workspace changes.",
    "goal creation/status updates, or skill-authored multi-agent coordination",
    "A request to create/start a goal also starts goal execution.",
    "emit one completed `goal_update`",
    "For command execution, call the available runtime command tool (`exec_command` or `shell`); if neither is callable, return that concrete blocker in `summary`.",
    "Current Studio runtime invariants:",
    "instafy agents context list --json",
];

/// A space whose skills include one that builds a trip with its own command, as the map pack's
/// does, and the router's words for it.
fn space() -> tempfile::TempDir {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let builder = tmp.path().join(".agents/skills/example-trip-builder");
    fs::create_dir_all(&builder).unwrap();
    fs::write(
        builder.join("SKILL.md"),
        "---\nname: example-trip-builder\ndescription: Build a trip page with the `trips` command.\ncontext_parent: instafy-skill-router\nrouting_keywords: trip, trips, travel, itinerary\n---\n\n# Trip pages\n\nRun `trips new <folder>` from a shell, then `trips add <place>` for each stop.\n",
    )
    .unwrap();
    tmp
}

/// A turn with an active goal, as the controller passes one.
fn metadata(transport: Option<&str>) -> JsonValue {
    let mut metadata = json!({
        "goal": { "objective": "Plan two days in Porto", "status": "active" },
    });
    if let Some(transport) = transport {
        metadata["browserTransport"] = json!(transport);
    }
    metadata
}

fn prompt_for(
    tmp: &std::path::Path,
    metadata: JsonValue,
    state: Option<&JsonValue>,
) -> (String, JsonValue) {
    let processor = test_job_processor(tmp);
    let project_id = Uuid::new_v4();
    let mut job = test_lease_job(Some("feature"), json!({ "metadata": metadata }));
    job.project_id = Some(project_id);
    let (prompt, _, metrics) = processor
        .build_prompt_with_text(
            &project_id,
            &job,
            tmp,
            REQUEST,
            true,
            state,
            &[],
            None,
            None,
        )
        .expect("prompt should build");
    (prompt, metrics)
}

/// The bundled browser skill as a turn that carries it whole reads it: all but the section only
/// the routing step reads.
fn skill_without_routing_section() -> String {
    let start = BROWSER_SKILL
        .find("\n## Routing preflight\n")
        .expect("routing section")
        + 1;
    BROWSER_SKILL[..start].trim_end().to_string()
}

#[test]
fn a_browser_turns_first_prompt_says_nothing_of_commands_files_team_plans_or_goals() {
    let tmp = space();
    for transport in ["shared", "desktop-personal"] {
        let (prompt, metrics) = prompt_for(tmp.path(), metadata(Some(transport)), None);
        assert_eq!(metrics["promptMode"], "full", "{transport}");
        for line in FIRST_PROMPT_WORKSPACE_LINES {
            assert!(!prompt.contains(line), "{transport}: {line}");
        }
        for word in [
            "multi_agent_plan",
            "goal_update",
            "apply_patch",
            "exec_command",
        ] {
            assert!(!prompt.contains(word), "{transport}: {word}");
        }
        // What it can use stays.
        for kept in [
            "\nPlease follow these constraints:\n- Respond with a single JSON object shaped as",
            "- Do not use the final assistant message for progress or status updates.",
            "- `summary` must be a natural, conversational reply to the latest user request.",
            "- Use `actions` for interactive UI help: secrets, integrations and location. Supported actions:\n",
            "- { type: 'request_location', optional precision: 'approximate' | 'precise', optional description: string }\n- If you emit `request_integration`,",
            "Never include secret values or tokens in chat or JSON.",
            "- When the user references another conversation (see \"Referenced conversations\"), treat it as additional context.\n- For browser/UI tasks, use this turn's browser tools when it has them and report observed page output.\n",
            "If a browser tool fails or refuses a page, that ends that page, not the task",
            "- Ask for clarification if you lack enough information to act.",
            "You are the Instafy Studio assistant collaborating with a teammate inside the project workspace.\n",
        ] {
            assert!(prompt.contains(kept), "{transport}: {kept}");
        }
        // Of the skills its words route, it loads the research skill, never the one that builds
        // with a command, nor the space's skills about running the workspace.
        assert!(
            prompt.contains("## Context: instafy-web-research ("),
            "{transport}"
        );
        for skill in [
            "example-trip-builder",
            "instafy-agent-collaboration",
            "instafy-group-participation",
            "instafy-learned",
            "instafy-persistent-contexts",
            "instafy-skill-reading",
            "instafy-skill-router",
        ] {
            assert!(
                !prompt.contains(&format!("## Context: {skill} (")),
                "{transport}: {skill}"
            );
        }
        let sections = &metrics["promptSections"];
        for section in ["delegationChoice", "activeGoal", "teamCapacity"] {
            assert!(sections.get(section).is_none(), "{transport}: {section}");
        }
    }
}

/// Its browser skill comes whole, but for the routing step's own section: no cut, no
/// "[truncated]".
#[test]
fn a_browser_turn_carries_its_browser_skill_whole() {
    let tmp = space();
    let whole = skill_without_routing_section();
    assert!(whole.len() > PROJECT_MEMORY_MAX_FILE_BYTES);
    assert!(whole.len() <= PINNED_SKILL_MAX_BYTES);
    let block = format!("{BROWSER_SKILL_HEADING}\n```markdown\n{whole}\n```\n");
    for transport in ["shared", "desktop-personal"] {
        let (prompt, _) = prompt_for(tmp.path(), metadata(Some(transport)), None);
        let start = prompt
            .find(&block)
            .unwrap_or_else(|| panic!("{transport}: not whole"));
        assert!(
            !prompt[start + block.len()..].starts_with("[truncated]"),
            "{transport}"
        );
        assert!(!prompt.contains("## Routing preflight"), "{transport}");
    }
}

/// A building turn with the same words keeps every line: the command, file, team plan and goal
/// lines, the skill that builds with a command, the collaboration skill's delegation choice, and
/// the first `PROJECT_MEMORY_MAX_FILE_BYTES` of a skill it routes.
#[test]
fn a_building_turns_prompt_keeps_every_line() {
    let tmp = space();
    let (prompt, metrics) = prompt_for(tmp.path(), metadata(None), None);
    assert_eq!(metrics["promptMode"], "full");
    for line in FIRST_PROMPT_WORKSPACE_LINES {
        assert!(prompt.contains(line), "{line}");
    }
    assert!(prompt.contains("## Context: example-trip-builder ("));
    assert!(prompt.contains("Run `trips new <folder>` from a shell"));
    for section in ["delegationChoice", "activeGoal"] {
        assert!(
            metrics["promptSections"].get(section).is_some(),
            "{section}"
        );
    }
    let (restored, _) = prompt_for(
        tmp.path(),
        metadata(None),
        Some(&json!({"defaultThreadId": "existing-thread", "historyReplayRequired": false})),
    );
    for line in REMINDER_WORKSPACE_LINES {
        assert!(restored.contains(line), "{line}");
    }

    // The research skill points a building turn to the browser skill, which it carries cut at
    // `PROJECT_MEMORY_MAX_FILE_BYTES`, as before.
    let snapshot = format_project_memory_snapshot(
        tmp.path(),
        "What does the Stripe pricing page say about the team plan?",
    )
    .expect("snapshot");
    let start = snapshot
        .text
        .find(BROWSER_SKILL_HEADING)
        .expect("browser skill");
    let block = &snapshot.text[start..];
    let carried =
        String::from_utf8_lossy(&BROWSER_SKILL.as_bytes()[..PROJECT_MEMORY_MAX_FILE_BYTES]);
    assert!(block.contains(carried.trim_end()));
    assert!(block.contains("\n```\n[truncated]\n"));
}

/// A browser turn on a restored thread is reminded of the reply's shape and the actions it can
/// take, and nothing of files, commands, goals, team plans, context cards or devices. A thread
/// begun before keeps working: it is resumed the same way, and its first turn's longer text stays
/// in its history.
#[test]
fn a_restored_browser_turn_is_reminded_only_of_what_it_can_use() {
    let tmp = space();
    let state = json!({
        "defaultThreadId": "existing-thread",
        "sharedBrowserThreadId": "existing-browser-thread",
        "historyReplayRequired": false,
    });
    for transport in ["shared", "desktop-personal"] {
        let (prompt, metrics) = prompt_for(tmp.path(), metadata(Some(transport)), Some(&state));
        assert_eq!(metrics["promptMode"], "stateful_compact", "{transport}");
        for line in REMINDER_WORKSPACE_LINES {
            assert!(!prompt.contains(line), "{transport}: {line}");
        }
        assert!(!prompt.contains("Active conversation goal:"), "{transport}");
        let reminder = prompt
            .split("\nResponse contract reminder:\n")
            .nth(1)
            .and_then(|rest| rest.split("\n\n").next())
            .expect("restored reminder");
        assert_eq!(
            reminder,
            format!(
                "- Return one JSON object only: {{ \"summary\": string, \"files\": [], optional \"actions\": [] }}.\n\
                 - Put the natural-language answer in `summary`; do not wrap the JSON in Markdown.\n\
                 - Use `actions` for required secrets, integrations or location.\n{}",
                SECRET_REJECTION_CONTRACT
            )
            .trim_end(),
            "{transport}"
        );
        // It is still given "Finding a page" and the replies guide.
        assert!(
            prompt.contains("From `instafy-browser-automation`"),
            "{transport}"
        );
        assert!(prompt.contains("From `AGENTS.md`"), "{transport}");
    }
}

/// What the browser skill's turns never read (how to write a learned block, the owner-local tool
/// and the Personal Browser's own notes) is in a reference file the skill names, which every space
/// gets, so a browser turn reads the rest whole. A Personal Browser turn reads its browser's notes
/// in its run text; the one line that is not there, how a comparison uses its own tabs, stays in
/// the skill. An unedited earlier copy is upgraded.
#[test]
fn the_browser_skills_learning_and_local_browser_notes_are_in_a_reference_file() {
    for moved in [
        "## Learning boundary",
        "## Browser learning examples",
        "## Owner-local read-only observation",
        "## Personal Browser MCP",
    ] {
        assert!(!BROWSER_SKILL.contains(moved), "{moved}");
        assert!(BROWSER_SKILL_REFERENCE.contains(moved), "{moved}");
    }
    assert!(BROWSER_SKILL.contains("`references/learning-and-local-browsers.md`"));
    assert!(BROWSER_SKILL.contains(
        "- in the Personal Browser, a comparison or several related reads open each page in a tab of your own (`open_tab`, at most three of your tabs, each asking for its own site) and `select_tab` between them;"
    ));
    // The owner-local tool's own example call is still at hand, read with a command.
    assert!(BROWSER_SKILL_REFERENCE.contains("\"screenshot\": { \"path\": \"artifacts/browser/"));

    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let reference = tmp
        .path()
        .join(learn::BROWSER_AUTOMATION_REFERENCE_RELATIVE_PATH);
    assert_eq!(
        fs::read_to_string(&reference).unwrap(),
        BROWSER_SKILL_REFERENCE
    );
    let skill = tmp.path().join(learn::BROWSER_AUTOMATION_RELATIVE_PATH);
    let previous = include_str!("legacy/browser-automation-v24.md");
    assert!(previous.contains("## Learning boundary"));
    fs::write(&skill, previous).unwrap();
    learn::ensure_project_memory_scaffold(tmp.path());
    assert_eq!(fs::read_to_string(&skill).unwrap(), BROWSER_SKILL);
}
