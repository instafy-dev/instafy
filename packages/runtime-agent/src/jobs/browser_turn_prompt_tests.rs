//! A browser turn is given only what it can use. Its only tools are its browser's, so its prompt
//! says nothing of running a command, changing a file, or starting a team plan or a goal, and of
//! the skills it is told of only those it can use with no shell. A local test (Nov 1): a
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

/// A space whose skills include one that builds a trip with code of its own (a `scripts/`
/// folder), as the map pack's does, and one the space added with only a portal's browsing
/// guidance, and the router's words for each.
fn space() -> tempfile::TempDir {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let builder = tmp.path().join(".agents/skills/example-trip-builder");
    fs::create_dir_all(builder.join("scripts")).unwrap();
    fs::write(
        builder.join("SKILL.md"),
        "---\nname: example-trip-builder\ndescription: Build a trip page with the `trips` command.\ncontext_parent: instafy-skill-router\nrouting_keywords: trip, trips, travel, itinerary\n---\n\n# Trip pages\n\nRun `trips new <folder>` from a shell, then `trips add <place>` for each stop.\n",
    )
    .unwrap();
    fs::write(builder.join("scripts/trips.mjs"), "console.log('trips');\n").unwrap();
    let portal = tmp.path().join(".agents/skills/acme-portal");
    fs::create_dir_all(&portal).unwrap();
    fs::write(
        portal.join("SKILL.md"),
        "---\nname: acme-portal\ndescription: Find invoices and statements in the Acme customer portal.\nrouting_keywords: acme, acme portal, invoice, invoices, statement\n---\n\n# Acme portal\n\nInvoices are under Billing > Invoices, newest first. Never press Pay now.\n",
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
    prompt_for_request(tmp, REQUEST, metadata, state)
}

fn prompt_for_request(
    tmp: &std::path::Path,
    request: &str,
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
            request,
            true,
            state,
            &[],
            None,
            None,
        )
        .expect("prompt should build");
    (prompt, metrics)
}

/// The section of a prompt that opens with `heading`, up to the next `## ` heading.
fn section<'a>(prompt: &'a str, heading: &str) -> &'a str {
    let start = prompt
        .find(heading)
        .unwrap_or_else(|| panic!("no {heading}"));
    let rest = &prompt[start + heading.len()..];
    &rest[..rest.find("\n## ").unwrap_or(rest.len())]
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
        // Of the skills its words route, it loads the research skill, never one that runs code
        // of its own, nor the space's memory, routing and team skills.
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

/// Of the skills its words route, a browser turn loads each one it can use with no shell: one
/// the space added for a site's screens, and the integration skill's walk through a provider's
/// own screens in Instafy's browser. A code review of this change: a list of two skills by name
/// left both out, though `main` loaded them (a local test, Nov 1: the GitHub sign-in turn read
/// the integration skill).
#[test]
fn a_browser_turn_loads_every_routed_skill_it_can_use() {
    let tmp = space();
    for transport in ["shared", "desktop-personal"] {
        let (prompt, _) = prompt_for_request(
            tmp.path(),
            "In your browser, open the Acme portal and find my latest invoice.",
            metadata(Some(transport)),
            None,
        );
        assert!(
            prompt.contains("## Context: acme-portal ("),
            "{transport}: the space's own skill"
        );
        assert!(
            prompt.contains("Invoices are under Billing > Invoices, newest first."),
            "{transport}"
        );
        let (prompt, _) = prompt_for_request(
            tmp.path(),
            "Open github.com in your browser, sign me in, and star the instafy-dev/maps-skill-pack repository.",
            metadata(Some(transport)),
            None,
        );
        assert!(
            prompt.contains("## Context: instafy-integration-onboarding ("),
            "{transport}: the integration skill"
        );
    }
}

/// The skills index a browser turn reads names only the skills it can use: never one that runs
/// code of its own, builds, plans a team or runs the space's memory, whose descriptions are
/// themselves instructions to run a command (the map pack's: "build with its uw commands").
#[test]
fn a_browser_turns_skills_index_names_only_skills_it_can_use() {
    let tmp = space();
    for transport in ["shared", "desktop-personal"] {
        let (prompt, _) = prompt_for(tmp.path(), metadata(Some(transport)), None);
        let index = section(&prompt, "\n## Persistent contexts index (.agents/skills)\n");
        for listed in [
            "- instafy-browser-automation:",
            "- instafy-web-research:",
            "- instafy-location-sharing:",
            "- acme-portal:",
        ] {
            assert!(index.contains(listed), "{transport}: {listed}\n{index}");
        }
        for left_out in [
            "example-trip-builder",
            "instafy-interactive-artifacts",
            "instafy-frontend-previews",
            "instafy-research-team",
            "instafy-agent-collaboration",
            "instafy-skill-router",
            "instafy-learned",
        ] {
            assert!(
                !index.contains(left_out),
                "{transport}: {left_out}\n{index}"
            );
        }
        assert!(!prompt.contains("`trips`"), "{transport}");
    }
}

/// A skill a browser turn cannot use takes none of its router's places: three skills that run
/// code of their own and match the request better still leave the research skill its place.
#[test]
fn a_browser_turns_routed_skills_are_ones_it_can_use() {
    let tmp = space();
    for name in ["hours-finder-a", "hours-finder-b", "hours-finder-c"] {
        let folder = tmp.path().join(".agents/skills").join(name);
        fs::create_dir_all(folder.join("scripts")).unwrap();
        fs::write(
            folder.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: Look up opening hours with the `hours` command.\nrouting_keywords: opening hours, hours, official site, livraria, lello, bookshop\n---\n\n# Hours\n\nRun `hours <place>`.\n"
            ),
        )
        .unwrap();
        fs::write(folder.join("scripts/hours.mjs"), "").unwrap();
    }
    for transport in ["shared", "desktop-personal"] {
        let (prompt, _) = prompt_for(tmp.path(), metadata(Some(transport)), None);
        assert!(
            prompt.contains("## Context: instafy-web-research ("),
            "{transport}"
        );
        assert!(!prompt.contains("hours-finder"), "{transport}");
    }
}

/// A browser turn carries its browser skill whole, and the other skills its words route keep the
/// room they had beside it before: in a space whose memory is near its stated size budget (about
/// 10,000 bytes), the research skill still comes whole.
#[test]
fn a_browser_turns_other_skills_keep_their_room_beside_its_browser_skill() {
    let tmp = space();
    let memory = tmp.path().join(learn::INSTAFY_FILENAME);
    let mut text = fs::read_to_string(&memory).unwrap();
    while text.len() < 9_800 {
        text.push_str("- A preference this space keeps: reply in short, plain sentences.\n");
    }
    fs::write(&memory, text).unwrap();
    let research = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/assets/instafy/.agents/skills/instafy-web-research/SKILL.md"
    ));
    let whole = format!(
        "## Context: instafy-web-research (.agents/skills/instafy-web-research/SKILL.md)\n```markdown\n{}\n```\n",
        research.trim_end()
    );
    for transport in ["shared", "desktop-personal"] {
        let (prompt, _) = prompt_for(tmp.path(), metadata(Some(transport)), None);
        let start = prompt
            .find(&whole)
            .unwrap_or_else(|| panic!("{transport}: the research skill is not whole"));
        assert!(
            !prompt[start + whole.len()..].starts_with("[truncated]"),
            "{transport}"
        );
        assert!(prompt.contains(BROWSER_SKILL_HEADING), "{transport}");
    }
}

/// The client context a browser turn reads gives the person's time zone and language, and no
/// command: which `instafy` commands take `--timezone` is a building turn's line.
#[test]
fn a_browser_turns_client_context_names_no_command() {
    let tmp = space();
    let client = json!({ "timezone": "Europe/Lisbon", "locale": "pt-PT" });
    let restored = json!({
        "defaultThreadId": "existing-thread",
        "sharedBrowserThreadId": "existing-browser-thread",
        "historyReplayRequired": false,
    });
    for transport in ["shared", "desktop-personal"] {
        let mut turn = metadata(Some(transport));
        turn["client"] = client.clone();
        for state in [None, Some(&restored)] {
            let (prompt, _) = prompt_for(tmp.path(), turn.clone(), state);
            let context = prompt
                .split("\nClient context:\n")
                .nth(1)
                .and_then(|rest| rest.split("\n\n").next())
                .unwrap_or_else(|| panic!("{transport}: no client context"));
            assert!(
                context.contains("- Local timezone: Europe/Lisbon"),
                "{transport}: {context}"
            );
            assert!(context.contains("- Local locale: pt-PT"), "{transport}");
            assert!(!context.contains("instafy"), "{transport}: {context}");
            assert!(!context.contains("--timezone"), "{transport}: {context}");
        }
    }
    let mut building = metadata(None);
    building["client"] = client;
    let (prompt, _) = prompt_for(tmp.path(), building, None);
    assert!(prompt.contains(
        "- For `instafy recommendations remind`, `instafy automations create`, or a schedule update that needs a timezone, always pass `--timezone` explicitly"
    ));
}

/// Read whole, the browser skill tells a browser turn nothing that only a script or a shell can
/// do: the script-era lines of "Execution style" (an in-page `body.innerText()` fallback,
/// `browser.close()` and `browser.disconnect()`, `workedCues` printed in a command's evidence,
/// storing a learned block) are in its reference file, which names them for a turn with a shell.
#[test]
fn the_browser_skill_a_browser_turn_reads_whole_needs_no_script_or_shell() {
    let carried = skill_without_routing_section();
    for gone in [
        "body.innerText()",
        "browser.close()",
        "browser.disconnect()",
        "workedCues",
        "store the reusable cue pattern in a learned block",
        "with a command",
        "within the same session",
    ] {
        assert!(!carried.contains(gone), "{gone}");
    }
    for moved in [
        "read `body.innerText()` and extract the needed value from the actual visible label",
        "never call `browser.close()` unless the user explicitly asked to close the session",
        "under a compact `workedCues` object or array",
        "store the reusable cue pattern in a learned block",
    ] {
        assert!(BROWSER_SKILL_REFERENCE.contains(moved), "{moved}");
    }
    // What a browser turn does use stays.
    for kept in [
        "- Do not create inline Node/Playwright commands. Use only the bounded browser MCP exposed for the turn.",
        "  - do not leave the controlled tab hidden behind a different tab if the user should keep seeing it",
        "- If one browser tool call already produced every field the user or harness asked for, stop there.",
    ] {
        assert!(carried.contains(kept), "{kept}");
    }
}
