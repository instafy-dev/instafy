//! What each kind of turn reads before its first step, and what it no longer reads twice or at
//! all. A browser turn read about 68,000 characters before its first page (local tests, Oct 31 to
//! Nov 4), lines for commands it does not have among them, and lines that pulled different ways
//! ("read-only" and three statements of who builds, beside a request to make a page): the same
//! comparison message read eighteen, one, seven and one pages. A building turn read a memory file
//! that told it to load the memory its prompt already held, and ran that command first (ten
//! threads, 4,000 to 41,000 characters back).

use super::tests::{test_job_processor, test_lease_job};
use super::*;
use tempfile::tempdir;

const REQUEST: &str = "Compare the three latest laptops of one maker: processor, battery, weight and price, with two independent reviews each, as a comparison page.";

fn prompt(tmp: &Path, job: &LeaseJob) -> String {
    let processor = test_job_processor(tmp);
    let project_id = job.project_id.unwrap_or_else(Uuid::new_v4);
    processor
        .build_prompt_with_text(&project_id, job, tmp, REQUEST, true, None, &[], None, None)
        .expect("prompt should build")
        .0
}

fn job(metadata: JsonValue) -> LeaseJob {
    let mut job = test_lease_job(Some("feature"), json!({ "metadata": metadata }));
    job.project_id = Some(Uuid::new_v4());
    job
}

/// A routed build whose change the routing step left to inspection: a turn in the write lane with
/// the space's memory snapshot, as a hand-back is.
fn write_lane_job() -> LeaseJob {
    job_with_agent_routing_preflight(
        &job(json!({ "writeIntent": true })),
        &AgentRoutingPreflight {
            route: AgentRoutingPreflightRoute::Direct,
            reason: "A page from what the chat found.".to_string(),
            selected_skills: Vec::new(),
            confidence: 90,
            requires_context_lookup: false,
            requires_command_execution: false,
            workspace_file_change_requirement: WorkspaceFileChangeRequirement::Conditional,
            observation_commands: Vec::new(),
        },
    )
}

/// The space's `AGENTS.md` says how to run commands and how to reply. A browser turn has no
/// shell: it reads the replies guide, as it does on a restored thread, and a building turn reads
/// the file whole. A copy with no replies guide (a team's own) is carried whole.
#[test]
fn a_browser_turn_reads_only_the_replies_guide_of_agents_md() {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let agents = fs::read_to_string(tmp.path().join(learn::AGENTS_DOC_FILENAME)).unwrap();
    let replies = &agents[agents.find("## Replies").expect("replies")..];
    for transport in ["shared", "desktop-personal"] {
        let prompt = prompt(tmp.path(), &job(json!({ "browserTransport": transport })));
        let block = format!(
            "\n## AGENTS.md (AGENTS.md)\n```markdown\n{}\n```\n",
            replies.trim_end()
        );
        assert!(prompt.contains(&block), "{transport}\n{prompt}");
        for shell in ["## Responsiveness", "Treat “read-only”", "write_stdin"] {
            assert!(!prompt.contains(shell), "{transport}: {shell}");
        }
    }
    let building = prompt(tmp.path(), &job(json!({})));
    assert!(building.contains(&format!("```markdown\n{}\n```\n", agents.trim_end())));

    let own = "# Team notes\n\nAlways cite the city's own open data first.\n";
    fs::write(tmp.path().join(learn::AGENTS_DOC_FILENAME), own).unwrap();
    let browser = prompt(tmp.path(), &job(json!({ "browserTransport": "shared" })));
    assert!(browser.contains("Always cite the city's own open data first."));
}

/// No turn's memory tells it to load memory again: `AGENTS.md` and a new space's `INSTAFY.md` no
/// longer say to run `python AGENTS.py` first (it prints the snapshot the prompt already holds).
/// `/learn` still runs it, as its own prompt says. Unedited earlier copies of `AGENTS.md` are
/// upgraded.
#[test]
fn no_memory_file_tells_a_turn_to_load_its_memory_again() {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    for file in [learn::AGENTS_DOC_FILENAME, learn::INSTAFY_FILENAME] {
        let text = fs::read_to_string(tmp.path().join(file)).unwrap();
        for gone in [
            "python AGENTS.py",
            "Fast context load",
            "Start-of-task ritual",
            "first discover what skills/tools are available",
        ] {
            assert!(!text.contains(gone), "{file}: {gone}");
        }
    }
    let building = prompt(tmp.path(), &job(json!({})));
    assert!(!building.contains("Fast context load"));
    assert!(building.contains("For `/learn`, run `python AGENTS.py` if present"));

    let previous = include_str!("legacy/agents-doc-v12.md");
    assert!(previous.contains("## Fast context load (preferred)"));
    let path = tmp.path().join(learn::AGENTS_DOC_FILENAME);
    fs::write(&path, previous).unwrap();
    learn::ensure_project_memory_scaffold(tmp.path());
    assert!(
        !fs::read_to_string(&path)
            .unwrap()
            .contains("python AGENTS.py")
    );
}

/// A turn in the write lane emits no team plan, as its contract says: its memory snapshot leaves
/// out the collaboration skill (team plans, worker scopes, advisory locks), whose delegation
/// choice it reads once, in its own section. A hand-back carried the skill cut at 12,000 bytes
/// and its delegation choice twice, beside "Do not emit `multi_agent_plan`". A turn that may plan
/// a team keeps the skill.
#[test]
fn a_write_lane_turn_reads_the_delegation_choice_once_and_no_team_planning() {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let write = prompt(tmp.path(), &write_lane_job());
    assert!(write.contains("\nProject memory snapshot (from workspace; already loaded):\n"));
    assert!(write.contains("Do not emit `multi_agent_plan`"), "{write}");
    assert!(!write.contains("## Context: instafy-agent-collaboration ("));
    assert!(!write.contains("## Advisory locks"));
    assert_eq!(write.matches("## Delegation choice").count(), 1, "{write}");
    assert!(write.contains(
        "Current delegation policy from `.agents/skills/instafy-agent-collaboration/SKILL.md`"
    ));

    let structured = prompt(tmp.path(), &job(json!({})));
    assert!(structured.contains("## Context: instafy-agent-collaboration ("));
    // Neither carries the routing step's own section of it.
    for prompt in [&write, &structured] {
        assert!(!prompt.contains("## Routing preflight"));
        assert!(!prompt.contains("### Pending worker replies"));
    }
}

/// The index of learned blocks says how to open them; a space with none loads no index. A space
/// with a block loads the index.
#[test]
fn an_empty_learned_index_is_not_loaded() {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let request = "Check the inventory dashboard for low stock.";
    let snapshot = format_project_memory_snapshot(tmp.path(), request).expect("snapshot");
    assert!(!snapshot.text.contains("## Context: instafy-learned ("));
    assert!(!snapshot.text.contains("- instafy-learned\n"));

    let block = tmp
        .path()
        .join(learn::LEARNED_BLOCKS_DIR_RELATIVE_PATH)
        .join("inventory-dashboard");
    fs::create_dir_all(&block).unwrap();
    fs::write(
        block.join("SKILL.md"),
        "---\nname: inventory-dashboard\ndescription: Where the inventory dashboard lists low stock.\nrouting_keywords: inventory, dashboard, low stock\n---\n\nLow stock is under Reports > Stock.\n",
    )
    .unwrap();
    let snapshot = format_project_memory_snapshot(tmp.path(), request).expect("snapshot");
    assert!(snapshot.text.contains("## Context: instafy-learned ("));
}
